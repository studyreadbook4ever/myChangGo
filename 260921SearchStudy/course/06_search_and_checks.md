# 6. 검색을 실행하고 실패 원인을 나누어 보기

훈련 loss 하나로 모델의 동작을 다 설명할 수는 없다. 이제 같은 모델에서 위치를 제거하거나 토큰 테이블을 동결해 보면서 무엇이 필요한지 확인한다. 이어서 문서 벡터를 미리 계산하고, tokenizer·모델·문서 순서를 한 묶음으로 저장해 새 인스턴스에서 검색을 복원한다.

## 6.1 위치가 없는 attention은 순서 차이를 보존하는가

위치 표현이 없는 self-attention은 입력 토큰을 순열로 바꾸면 출력도 같은 순열로 바뀌는 성질을 가진다. 이를 permutation equivariance라고 한다. 그 출력에 순열 불변인 평균을 적용하면 결과는 같아진다. 이 교재의 segment ID는 전부 0이므로 별도의 순서 정보도 없다.

학습된 모델의 위치 벡터를 사용하지 않도록 바꿔 이 구조적 성질을 확인한다. 이것은 위치 없이 새로 학습한 모델과의 성능 비교는 아니다. 그 실험을 하려면 위치 없는 encoder를 새로 만들고 동일한 학습 조건으로 다시 학습해야 한다.

```python
no_position_model = copy.deepcopy(retriever).eval()
no_position_model.use_positions = False
order_diagnostics = []
with torch.no_grad():
    for left, right in ORDER_PAIRS:
        texts = [DOCS[left], DOCS[right]]
        normal_vectors = encode_texts(retriever, texts)
        no_position_vectors = encode_texts(no_position_model, texts)
        average_vectors = encode_texts(mean_model, texts)
        no_position_gap = float((no_position_vectors[0] - no_position_vectors[1]).norm())
        order_diagnostics.append([
            f"{left} / {right}", float((normal_vectors[0] - normal_vectors[1]).norm()),
            no_position_gap, float((average_vectors[0] - average_vectors[1]).norm()),
        ])
        torch.testing.assert_close(no_position_vectors[0], no_position_vectors[1], atol=2e-5, rtol=2e-5)
show_table(["문서 쌍", "학습된 문맥 모델 거리", "위치 제거 후 거리", "평균 모델 거리"], order_diagnostics)
```

벡터가 같거나 다른 것과 정답 문서가 1위가 되는 것도 별개다. 다른 벡터를 만들 수 있는 구조를 갖춘 뒤에는, 올바른 질의를 올바른 문서 쪽으로 배치하는 감독 신호가 필요하다. 위 표는 그중 표현 구조의 조건을 검사한다.

## 6.2 토큰 테이블을 고정하고 나머지만 학습한다

MLM 직후의 같은 초기 모델로 돌아가 E만 동결한다. 위치 표현, attention, FFN, projection은 계속 학습한다. 이 모델이 어느 정도 학습된다면 의미를 저장하는 장소를 E의 각 행 하나로만 설명할 수 없다는 것을 보여 준다. 그렇다고 토큰 임베딩 학습이 일반적으로 불필요하다는 결론이 나오지는 않는다.

```python
frozen_retriever = copy.deepcopy(initial_retriever)
frozen_history, frozen_table_change = train_retriever(
    frozen_retriever, retrieval_training, freeze_tokens=True
)
frozen_metrics, _ = evaluate_retrieval(frozen_retriever, VALID)
assert frozen_table_change == 0
show_table(["학습할 파라미터", "검증 Recall@1", "검증 MRR", "E 변화량"], [
    ["전체", retrieval_metrics["Recall@1"], retrieval_metrics["MRR"], retrieval_table_change],
    ["E를 제외한 나머지", frozen_metrics["Recall@1"], frozen_metrics["MRR"], frozen_table_change],
])
```

지금 비교는 한 seed와 작은 데이터에 대한 관찰이다. 차이가 작아 보이면 실행 실수부터 확인하고, 다른 seed와 다른 데이터에서 반복해야 한다. 결과를 보고 architecture나 hyperparameter를 선택하면 그 검증 집합은 선택 과정에 참여한다.

## 6.3 학습된 모델에 padding을 더해도 검색 벡터가 같은지 검사한다

앞 장에서는 초기 encoder를 검사했다. 학습된 모델에도 같은 규칙이 유지되는지 확인한다. 단일 문장을 뒤에 PAD 5개가 붙은 문장과 비교한다. 내용과 원래 위치는 그대로다.

```python
padding_batch = pack_batch([DOCS[0]])
longer_batch = {
    "input_ids": F.pad(padding_batch["input_ids"], (0, 5), value=tokenizer.pad_id),
    "attention_mask": F.pad(padding_batch["attention_mask"], (0, 5), value=False),
    "pool_mask": F.pad(padding_batch["pool_mask"], (0, 5), value=False),
    "token_type_ids": F.pad(padding_batch["token_type_ids"], (0, 5), value=0),
}
with torch.no_grad():
    ordinary_vector = retriever(padding_batch)
    padded_vector = retriever(longer_batch)
torch.testing.assert_close(ordinary_vector, padded_vector, atol=2e-5, rtol=2e-5)
padding_error = float((ordinary_vector - padded_vector).abs().max())
print("padding 추가 후 좌표별 최대 차이:", padding_error)
```

문제의 원인을 찾을 때 이처럼 불변이어야 하는 값을 정해 두면 편하다. 질의 자체가 바뀌었는데 결과가 변하는 것은 자연스럽지만, PAD만 추가했는데 순위가 크게 바뀐다면 attention mask나 pooling을 먼저 검사해야 한다.

## 6.4 문서 벡터를 미리 계산해서 검색한다

학습이 끝났으므로 문서 벡터를 한 번만 계산한다. 질의가 들어오면 질의 하나를 인코딩하고 저장된 행렬과 곱한다. 아래 구현은 모든 문서를 정확히 비교하는 exact search다. 현재 12개 문서에는 이것으로 충분하다.

```python
retriever.eval()
with torch.no_grad():
    document_index = encode_texts(retriever, DOCS).detach().clone()
assert document_index.shape == (len(DOCS), 32)
torch.testing.assert_close(document_index.norm(dim=1), torch.ones(len(DOCS)), atol=1e-6, rtol=1e-5)

@torch.no_grad()
def search_documents(query, model, tokenizer, document_vectors, documents, names, top_k=3):
    if not 1 <= top_k <= len(documents):
        raise ValueError("top_k는 1 이상 문서 수 이하여야 합니다.")
    if document_vectors.shape[0] != len(documents) or len(names) != len(documents):
        raise ValueError("벡터의 행 순서와 문서 목록이 맞아야 합니다.")
    model.eval()
    batch = pack_batch([query], tokenizer=tokenizer, max_len=model.max_len)
    query_vector = model(batch)
    scores = (query_vector @ document_vectors.T)[0]
    if not torch.isfinite(scores).all():
        raise FloatingPointError("검색 점수에 NaN 또는 무한대가 있습니다.")
    ranking = scores.argsort(descending=True, stable=True)[:top_k].tolist()
    content_ids = batch["input_ids"][batch["pool_mask"]]
    unknown_count = int((content_ids == tokenizer.unk_id).sum())
    rows = [{"id": index, "score": float(scores[index]), "name": names[index], "text": documents[index]}
            for index in ranking]
    return rows, {"unknown_tokens": unknown_count, "content_tokens": len(content_ids)}

my_query = "쥐 가 고양이 를 뒤쫓다 장면"
hits, input_info = search_documents(my_query, retriever, tokenizer, document_index, DOCS, DOC_NAMES)
print("질의:", my_query, "/ 토큰 정보:", input_info)
show_table(["순위", "문서 ID", "cosine", "문서"],
           [[rank, hit["id"], round(hit["score"], 5), hit["text"]] for rank, hit in enumerate(hits, 1)])
```

위 셀의 `my_query`만 바꾸면 자신의 질의를 넣을 수 있다. 이 BPE는 어절을 문자로 분해할 수 있으므로, 학습 때 없었던 단어도 이미 배운 문자들의 조합이면 표현할 수 있다. 그래도 새로운 표현의 의미를 배웠다는 보장은 없다. 학습된 문자만으로 표현 가능한 새로운 단어와, `[UNK]`가 생기는 새로운 문자를 분리해서 봐야 한다.

```python
oov_rows = []
for query in ["고양이쥐", "패스워드 리커버리", "고양이 🧬"]:
    oov_hits, info = search_documents(query, retriever, tokenizer, document_index, DOCS, DOC_NAMES)
    oov_rows.append([query, info["unknown_tokens"], info["content_tokens"],
                     oov_hits[0]["name"], round(oov_hits[0]["score"], 4)])
show_table(["입력", "UNK 수", "내용 토큰 수", "반환된 1위", "점수"], oov_rows)
```

모르는 입력에도 1위는 나온다. 검색기는 후보를 정렬했을 뿐, 정답이 존재한다고 판정하지 않았다. 실제 제품에서는 정답 없는 질의도 포함한 검증 자료로 응답 보류나 threshold를 설계해야 한다. 이 작은 자료의 점수를 보고 모든 서비스에 쓸 threshold 하나를 정할 수는 없다.

## 6.5 저장할 단위는 가중치 파일 하나보다 크다

동일한 가중치라도 토크나이저 ID가 바뀌면 다른 함수를 계산한다. 문서 벡터의 행 순서와 문서 목록이 바뀌면 점수는 맞아도 엉뚱한 문서를 돌려준다. 모델을 갱신하고 기존 문서 벡터를 계속 써도 질의와 문서가 서로 다른 공간에 놓일 수 있다.

따라서 이 실습은 tokenizer의 정규화·merge·ID 순서, 모델 구조와 가중치, pooling 설정, 문서 목록과 벡터를 한 묶음으로 저장한다. optimizer 상태는 저장하지 않는다. 아래 파일은 추론을 재현하는 checkpoint이며, 학습을 정확히 이어서 재개하는 checkpoint는 아니다. 학습 재개에는 optimizer와 RNG 상태, 데이터 진행 위치도 필요하다.

```python
bundle = {
    "format_version": 1,
    "tokenizer": tokenizer.to_dict(),
    "encoder_config": asdict(encoder_config),
    "retriever_config": {"output_dim": retriever.output_dim,
                         "pooling": retriever.pooling, "use_positions": retriever.use_positions},
    "state_dict": retriever.state_dict(),
    "documents": list(DOCS),
    "document_names": list(DOC_NAMES),
    "document_vectors": document_index,
}
bundle_path = ARTIFACT_DIR / "retriever.pt"
torch.save(bundle, bundle_path)

loaded = torch.load(bundle_path, map_location="cpu", weights_only=True)
if loaded["format_version"] != 1:
    raise ValueError("지원하지 않는 checkpoint 버전입니다.")
loaded_tokenizer = ScratchBPE.from_dict(loaded["tokenizer"])
loaded_config = ModelConfig(**loaded["encoder_config"])
assert loaded_config.vocab_size == loaded_tokenizer.vocab_size
loaded_model = SentenceEncoder(TinyBert(loaded_config), **loaded["retriever_config"])
loaded_model.load_state_dict(loaded["state_dict"])
loaded_model.eval()
loaded_documents = loaded["documents"]
loaded_names = loaded["document_names"]
loaded_index = loaded["document_vectors"]

with torch.no_grad():
    recomputed_index = encode_texts(loaded_model, loaded_documents, loaded_tokenizer)
torch.testing.assert_close(recomputed_index, loaded_index, atol=0, rtol=0)
loaded_hits, _ = search_documents(my_query, loaded_model, loaded_tokenizer,
                                   loaded_index, loaded_documents, loaded_names)
assert [hit["id"] for hit in loaded_hits] == [hit["id"] for hit in hits]
print("새 인스턴스에서 벡터와 검색 순위 복원:", bundle_path.name)
```

여기서는 같은 CPU 환경에서 같은 계산을 수행하므로 완전 일치를 검사했다. 다른 장치나 수치 정밀도로 옮길 때에는 허용 오차와 순위 안정성을 따로 확인해야 한다. 위 저장 파일에서 가중치만 바꾸고 벡터는 그대로 두는 식의 수동 변경은 하지 않는다.

## 6.6 별도로 보관한 질의의 결과를 확인한다

토크나이저, MLM, 검색 학습은 모두 끝났다. 이제 처음 분리한 `TEST` 질의를 평가한다. 이 집합 역시 같은 문서와 유사한 표현을 공유하는 합성 자료다. 별도 문자열이라는 조건은 지키지만, 새로운 언어·도메인·entity에 대한 성능 증거로 확대할 수는 없다.

```python
test_metrics, test_rows = evaluate_retrieval(retriever, TEST)
test_mean_metrics, _ = evaluate_retrieval(mean_model, TEST)
show_table(["구조", "TEST Recall@1", "TEST Recall@3", "TEST MRR"], [
    ["평균", *(round(test_mean_metrics[k], 4) for k in ("Recall@1", "Recall@3", "MRR"))],
    ["문맥 encoder", *(round(test_metrics[k], 4) for k in ("Recall@1", "Recall@3", "MRR"))],
])
errors = [row for row in test_rows if row["rank"] != 1]
show_table(["질의", "정답", "정답 순위", "상위 3개"], [
    [row["query"], DOC_NAMES[row["target"]], row["rank"],
     ", ".join(DOC_NAMES[i] for i in row["top3"])] for row in errors
])
print("1위 오류 질의 수:", len(errors), "/", len(TEST))
```

오류가 없다면 문제를 더 잘 설계해야 한다. 모든 학습 질의와 비슷한 템플릿만 평가하면 모델이 문장 구조를 일반화했는지, 단순히 반복되는 조합을 외웠는지 구별하기 어렵다. 다음 장의 과제는 새로운 entity와 관계 조합을 분리해 이 한계를 드러내는 것이다. 반대로 오류가 있다면 학습 epoch를 늘리기 전에 토큰화, 정답의 모호성, 순서를 잃은 표현, 실제 문맥 추론 실패 중 어디에 속하는지 분류한다.

```python
course_report = {
    "python": sys.version.split()[0], "torch": torch.__version__,
    "seeds": {"global": SEED, "mlm_initialization": 41, "mlm_corruption": 45,
              "mlm_diagnostic": 44, "retrieval_projection": 17},
    "vocabulary_size": tokenizer.vocab_size, "bpe_merges": len(tokenizer.merges),
    "encoder_config": asdict(encoder_config), "retrieval_training": asdict(retrieval_training),
    "data": {"documents": len(DOCS), "train": len(TRAIN), "validation": len(VALID), "test": len(TEST)},
    "mlm_diagnostic_before": mlm_before, "mlm_diagnostic_after": mlm_after,
    "retrieval_validation_before": initial_metrics,
    "retrieval_validation_after": retrieval_metrics, "mean_validation_after": mean_metrics,
    "frozen_validation_after": frozen_metrics,
    "retrieval_test": test_metrics, "mean_test": test_mean_metrics,
    "embedding_gradient": {"autograd": autograd_gradient, "finite_difference": numeric_gradient},
    "padding_error": padding_error, "frozen_table_change": frozen_table_change,
    "order_diagnostics": order_diagnostics,
    "test_predictions": test_rows,
    "elapsed_seconds": time.perf_counter() - STARTED_AT,
    "evaluation_scope": "Synthetic queries against a known corpus; not a natural-language benchmark.",
}
(ARTIFACT_DIR / "results.json").write_text(json.dumps(course_report, ensure_ascii=False, indent=2), encoding="utf-8")
print("실행 결과 저장:", Path("artifacts/course/results.json"))
print("여기까지의 실행 시간:", round(course_report["elapsed_seconds"], 2), "초")
```
