import json, math, unicodedata, sys
from collections import Counter
from dataclasses import dataclass, asdict
from pathlib import Path
import torch
from torch import nn
from torch.nn import functional as F
torch.set_num_threads(1)
SPECIAL_PIECES = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]"]
WORD_START = "▁"
bundle = torch.load(Path(sys.argv[1]), map_location="cpu", weights_only=True)


def normalize_text(text):
    if not isinstance(text, str):
        raise TypeError('입력은 문자열이어야 합니다.')
    text = unicodedata.normalize('NFKC', text)
    if WORD_START in text or any((piece in text for piece in SPECIAL_PIECES)):
        raise ValueError('입력에 내부용 표식 또는 special-token 표기가 있습니다.')
    text = ' '.join(text.split())
    if not text:
        raise ValueError('공백만 있는 문장은 처리하지 않습니다.')
    return text

def count_pairs(segmented_words):
    counts = Counter()
    for symbols, frequency in segmented_words.items():
        for pair in zip(symbols, symbols[1:]):
            counts[pair] += frequency
    return counts

def merge_pair(symbols, pair):
    result = []
    index = 0
    while index < len(symbols):
        if index + 1 < len(symbols) and (symbols[index], symbols[index + 1]) == pair:
            result.append(symbols[index] + symbols[index + 1])
            index += 2
        else:
            result.append(symbols[index])
            index += 1
    return tuple(result)

def choose_pair(pair_counts):
    return min(pair_counts, key=lambda pair: (-pair_counts[pair], pair))

def apply_bpe_to_word(word, merge_ranks):
    symbols = tuple(WORD_START + word)
    while len(symbols) > 1:
        candidates = [pair for pair in zip(symbols, symbols[1:]) if pair in merge_ranks]
        if not candidates:
            break
        chosen = min(candidates, key=merge_ranks.__getitem__)
        symbols = merge_pair(symbols, chosen)
    return symbols

class ScratchBPE:
    pad_id, unk_id, cls_id, sep_id, mask_id = range(5)

    def __init__(self):
        self.pieces = list(SPECIAL_PIECES)
        self.piece_to_id = {piece: i for i, piece in enumerate(self.pieces)}
        self.merges = []
        self.merge_ranks = {}
        self.ready = False

    @property
    def vocab_size(self):
        return len(self.pieces)

    def fit(self, texts, num_merges=100, min_pair_frequency=2):
        if num_merges < 0 or min_pair_frequency < 1:
            raise ValueError('num_merges는 0 이상, min_pair_frequency는 1 이상입니다.')
        word_counts = Counter((word for text in texts for word in normalize_text(text).split()))
        if not word_counts:
            raise ValueError('토크나이저를 학습할 문장이 없습니다.')
        self.__init__()
        alphabet = sorted(set(WORD_START + ''.join(word_counts)))
        self.pieces.extend(alphabet)
        self.piece_to_id = {piece: i for i, piece in enumerate(self.pieces)}
        segmented = Counter({tuple(WORD_START + word): freq for word, freq in word_counts.items()})
        for _ in range(num_merges):
            counts = count_pairs(segmented)
            if not counts:
                break
            pair = choose_pair(counts)
            if counts[pair] < min_pair_frequency:
                break
            self.merges.append(pair)
            joined = ''.join(pair)
            if joined not in self.piece_to_id:
                self.piece_to_id[joined] = len(self.pieces)
                self.pieces.append(joined)
            updated = Counter()
            for symbols, frequency in segmented.items():
                updated[merge_pair(symbols, pair)] += frequency
            segmented = updated
        self.merge_ranks = {pair: rank for rank, pair in enumerate(self.merges)}
        self.ready = True
        return self

    def encode(self, text, add_special_tokens=True):
        if not self.ready:
            raise RuntimeError('fit 또는 from_dict를 먼저 실행하세요.')
        ids = []
        for word in normalize_text(text).split():
            symbols = apply_bpe_to_word(word, self.merge_ranks)
            ids.extend((self.piece_to_id.get(piece, self.unk_id) for piece in symbols))
        return [self.cls_id, *ids, self.sep_id] if add_special_tokens else ids

    def decode(self, ids, skip_special_tokens=True):
        if not self.ready:
            raise RuntimeError('fit 또는 from_dict를 먼저 실행하세요.')
        pieces = []
        controls = {self.pad_id, self.cls_id, self.sep_id, self.mask_id}
        for index in ids:
            index = int(index)
            if not 0 <= index < self.vocab_size:
                raise ValueError(f'어휘 밖 ID: {index}')
            if not (skip_special_tokens and index in controls):
                pieces.append(self.pieces[index])
        return ''.join(pieces).replace(WORD_START, ' ').strip()

    def to_dict(self):
        if not self.ready:
            raise RuntimeError('학습한 상태만 저장할 수 있습니다.')
        return {'version': 1, 'normalization': 'NFKC+collapse_whitespace', 'word_start': WORD_START, 'pieces': list(self.pieces), 'merges': [list(pair) for pair in self.merges]}

    @classmethod
    def from_dict(cls, state):
        if state.get('version') != 1 or state.get('word_start') != WORD_START or state.get('normalization') != 'NFKC+collapse_whitespace':
            raise ValueError('지원하지 않는 토크나이저 저장 형식입니다.')
        obj = cls()
        obj.pieces = list(state['pieces'])
        if obj.pieces[:5] != SPECIAL_PIECES or len(set(obj.pieces)) != len(obj.pieces):
            raise ValueError('special-token ID 또는 어휘의 유일성이 깨졌습니다.')
        obj.piece_to_id = {piece: i for i, piece in enumerate(obj.pieces)}
        obj.merges = [tuple(pair) for pair in state['merges']]
        if any((len(pair) != 2 or any((p not in obj.piece_to_id for p in pair)) or ''.join(pair) not in obj.piece_to_id for pair in obj.merges)):
            raise ValueError('어휘와 merge 규칙이 일치하지 않습니다.')
        obj.merge_ranks = {pair: rank for rank, pair in enumerate(obj.merges)}
        if len(obj.merge_ranks) != len(obj.merges):
            raise ValueError('merge 규칙이 중복되었습니다.')
        obj.ready = True
        return obj

tokenizer = ScratchBPE.from_dict(bundle["tokenizer"])

def pack_batch(texts, tokenizer=tokenizer, max_len=96):
    if isinstance(texts, str):
        raise TypeError('문장 하나도 [문장] 형태로 전달하세요.')
    texts = list(texts)
    if not texts or not isinstance(max_len, int) or max_len < 3:
        raise ValueError('배치는 비어 있을 수 없고 max_len은 3 이상의 정수입니다.')
    encoded = [tokenizer.encode(text) for text in texts]
    lengths = [len(ids) for ids in encoded]
    if max(lengths) > max_len:
        raise ValueError(f'토큰 길이 {max(lengths)}가 max_len={max_len}을 넘었습니다. chunk 설계가 필요합니다.')
    input_ids = torch.full((len(encoded), max(lengths)), tokenizer.pad_id, dtype=torch.long)
    attention_mask = torch.zeros_like(input_ids, dtype=torch.bool)
    pool_mask = torch.zeros_like(input_ids, dtype=torch.bool)
    for row, ids in enumerate(encoded):
        input_ids[row, :len(ids)] = torch.tensor(ids, dtype=torch.long)
        attention_mask[row, :len(ids)] = True
        pool_mask[row, 1:len(ids) - 1] = True
    return {'input_ids': input_ids, 'attention_mask': attention_mask, 'pool_mask': pool_mask, 'token_type_ids': torch.zeros_like(input_ids)}

@dataclass
class ModelConfig:
    vocab_size: int
    max_len: int = 96
    d_model: int = 48
    n_heads: int = 4
    n_layers: int = 2
    d_ff: int = 96
    dropout: float = 0.0

    def __post_init__(self):
        if min(self.vocab_size, self.max_len, self.d_model, self.n_heads, self.n_layers, self.d_ff) <= 0:
            raise ValueError('모델 크기는 양수여야 합니다.')
        if self.d_model % self.n_heads != 0:
            raise ValueError('d_model은 n_heads로 나누어떨어져야 합니다.')
        if not 0 <= self.dropout < 1:
            raise ValueError('dropout은 0 이상 1 미만이어야 합니다.')

class BertEmbeddings(nn.Module):

    def __init__(self, config):
        super().__init__()
        self.token = nn.Embedding(config.vocab_size, config.d_model, padding_idx=0)
        self.position = nn.Embedding(config.max_len, config.d_model)
        self.segment = nn.Embedding(2, config.d_model)
        self.norm = nn.LayerNorm(config.d_model, eps=1e-05)
        self.dropout = nn.Dropout(config.dropout)
        for table in (self.token, self.position, self.segment):
            nn.init.normal_(table.weight, mean=0.0, std=0.02)
        with torch.no_grad():
            self.token.weight[0].zero_()

    def forward(self, input_ids, token_type_ids=None, use_positions=True):
        if input_ids.ndim != 2 or input_ids.shape[1] == 0:
            raise ValueError('input_ids는 비어 있지 않은 [B,T] 배열이어야 합니다.')
        length = input_ids.shape[1]
        if length > self.position.num_embeddings:
            raise ValueError('입력 길이가 위치 테이블의 max_len을 넘었습니다.')
        if token_type_ids is None:
            token_type_ids = torch.zeros_like(input_ids)
        if token_type_ids.shape != input_ids.shape:
            raise ValueError('token_type_ids와 input_ids의 크기가 다릅니다.')
        hidden = self.token(input_ids) + self.segment(token_type_ids)
        if use_positions:
            positions = torch.arange(length, device=input_ids.device)[None, :]
            hidden = hidden + self.position(positions)
        return self.dropout(self.norm(hidden))

class MultiHeadSelfAttention(nn.Module):

    def __init__(self, config):
        super().__init__()
        self.n_heads = config.n_heads
        self.head_dim = config.d_model // config.n_heads
        self.q_proj = nn.Linear(config.d_model, config.d_model)
        self.k_proj = nn.Linear(config.d_model, config.d_model)
        self.v_proj = nn.Linear(config.d_model, config.d_model)
        self.out_proj = nn.Linear(config.d_model, config.d_model)
        self.dropout = nn.Dropout(config.dropout)

    def split_heads(self, hidden):
        batch, length, _ = hidden.shape
        return hidden.reshape(batch, length, self.n_heads, self.head_dim).transpose(1, 2)

    def forward(self, hidden, attention_mask):
        if attention_mask.shape != hidden.shape[:2]:
            raise ValueError('attention_mask는 hidden의 [B,T]와 맞아야 합니다.')
        valid = attention_mask.bool()
        if not bool(valid.any(dim=1).all()):
            raise ValueError('각 입력에는 최소 한 개의 유효한 key가 필요합니다.')
        q = self.split_heads(self.q_proj(hidden))
        k = self.split_heads(self.k_proj(hidden))
        v = self.split_heads(self.v_proj(hidden))
        scores = q @ k.transpose(-2, -1) / math.sqrt(self.head_dim)
        scores = scores.masked_fill(~valid[:, None, None, :], float('-inf'))
        weights = torch.softmax(scores, dim=-1)
        context = self.dropout(weights) @ v
        batch, _, length, _ = context.shape
        merged = context.transpose(1, 2).contiguous().reshape(batch, length, -1)
        return (self.out_proj(merged), weights)

class EncoderBlock(nn.Module):

    def __init__(self, config):
        super().__init__()
        self.attention = MultiHeadSelfAttention(config)
        self.attention_dropout = nn.Dropout(config.dropout)
        self.norm1 = nn.LayerNorm(config.d_model, eps=1e-05)
        self.ffn = nn.Sequential(nn.Linear(config.d_model, config.d_ff), nn.GELU(), nn.Linear(config.d_ff, config.d_model))
        self.ffn_dropout = nn.Dropout(config.dropout)
        self.norm2 = nn.LayerNorm(config.d_model, eps=1e-05)

    def forward(self, hidden, attention_mask):
        attended, weights = self.attention(hidden, attention_mask)
        hidden = self.norm1(hidden + self.attention_dropout(attended))
        hidden = self.norm2(hidden + self.ffn_dropout(self.ffn(hidden)))
        return (hidden, weights)

class TinyBert(nn.Module):

    def __init__(self, config):
        super().__init__()
        self.config = config
        self.embeddings = BertEmbeddings(config)
        self.layers = nn.ModuleList([EncoderBlock(config) for _ in range(config.n_layers)])

    def forward(self, input_ids, attention_mask, token_type_ids=None, use_positions=True, return_attentions=False):
        if input_ids.ndim != 2 or input_ids.numel() == 0:
            raise ValueError('input_ids는 비어 있지 않은 [B,T] 배열이어야 합니다.')
        if input_ids.dtype != torch.long:
            raise TypeError('input_ids는 torch.long이어야 합니다.')
        if attention_mask.shape != input_ids.shape:
            raise ValueError('attention_mask와 input_ids의 크기가 다릅니다.')
        if not bool(attention_mask.bool().any(dim=1).all()):
            raise ValueError('모든 위치가 PAD인 문장은 처리할 수 없습니다.')
        hidden = self.embeddings(input_ids, token_type_ids, use_positions)
        attentions = []
        for layer in self.layers:
            hidden, weights = layer(hidden, attention_mask)
            if return_attentions:
                attentions.append(weights)
        if return_attentions:
            return (hidden, attentions)
        return hidden

def masked_mean(hidden, pool_mask):
    counts = pool_mask.sum(dim=1, keepdim=True)
    if (counts == 0).any():
        raise ValueError('평균을 낼 내용 토큰이 없는 문장이 있습니다.')
    weights = pool_mask.unsqueeze(-1).to(hidden.dtype)
    return (hidden * weights).sum(dim=1) / counts.to(hidden.dtype)

class SentenceEncoder(nn.Module):

    def __init__(self, encoder, output_dim=32, pooling='mean', use_positions=True):
        super().__init__()
        if pooling not in {'mean', 'cls'}:
            raise ValueError('pooling은 mean 또는 cls여야 합니다.')
        self.encoder = encoder
        self.max_len = encoder.config.max_len
        self.pooling = pooling
        self.use_positions = use_positions
        self.output_dim = output_dim
        self.projection = nn.Linear(encoder.config.d_model, output_dim, bias=False)

    def forward(self, batch):
        hidden = self.encoder(batch['input_ids'], batch['attention_mask'], batch['token_type_ids'], use_positions=self.use_positions)
        pooled = masked_mean(hidden, batch['pool_mask']) if self.pooling == 'mean' else hidden[:, 0]
        projected = self.projection(pooled)
        return F.normalize(projected, p=2, dim=-1, eps=1e-12)

def encode_texts(model, texts, tokenizer=tokenizer):
    return model(pack_batch(texts, tokenizer=tokenizer, max_len=model.max_len))

@torch.no_grad()
def search_documents(query, model, tokenizer, document_vectors, documents, names, top_k=3):
    if not 1 <= top_k <= len(documents):
        raise ValueError('top_k는 1 이상 문서 수 이하여야 합니다.')
    if document_vectors.shape[0] != len(documents) or len(names) != len(documents):
        raise ValueError('벡터의 행 순서와 문서 목록이 맞아야 합니다.')
    model.eval()
    batch = pack_batch([query], tokenizer=tokenizer, max_len=model.max_len)
    query_vector = model(batch)
    scores = (query_vector @ document_vectors.T)[0]
    if not torch.isfinite(scores).all():
        raise FloatingPointError('검색 점수에 NaN 또는 무한대가 있습니다.')
    ranking = scores.argsort(descending=True, stable=True)[:top_k].tolist()
    content_ids = batch['input_ids'][batch['pool_mask']]
    unknown_count = int((content_ids == tokenizer.unk_id).sum())
    rows = [{'id': index, 'score': float(scores[index]), 'name': names[index], 'text': documents[index]} for index in ranking]
    return (rows, {'unknown_tokens': unknown_count, 'content_tokens': len(content_ids)})


config = ModelConfig(**bundle["encoder_config"])
model = SentenceEncoder(TinyBert(config), **bundle["retriever_config"])
model.load_state_dict(bundle["state_dict"])
model.eval()
with torch.no_grad():
    vectors = encode_texts(model, bundle["documents"], tokenizer)
torch.testing.assert_close(vectors, bundle["document_vectors"], atol=0, rtol=0)
hits, info = search_documents("쥐 가 고양이 를 뒤쫓다 장면", model, tokenizer,
                              vectors, bundle["documents"], bundle["document_names"])
assert hits[0]["id"] == 1
for text in ["", "[PAD]", "고양이 [MASK]", "고양이 ▁ 쥐"]:
    try:
        tokenizer.encode(text)
    except ValueError:
        pass
    else:
        raise AssertionError(f"예약 표식/빈 입력이 허용됨: {text!r}")
# 기본값 96과 다른 저장 설정도 전처리에서 따라가는지 확인한다.
extended_config = ModelConfig(vocab_size=tokenizer.vocab_size, max_len=128)
extended_model = SentenceEncoder(TinyBert(extended_config)).eval()
long_query = " ".join(["쥐"] * 100)
with torch.no_grad():
    long_vector = encode_texts(extended_model, [long_query], tokenizer)
assert long_vector.shape == (1, 32)
print(json.dumps({"restored_vectors_exact": True, "top_document_id": hits[0]["id"],
                  "separate_process": True, "reserved_inputs_rejected": True,
                  "nondefault_max_length": True}, ensure_ascii=False))
