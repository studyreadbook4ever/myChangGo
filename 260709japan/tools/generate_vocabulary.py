#!/usr/bin/env python3
from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "app" / "src" / "main" / "assets" / "vocabulary.tsv"


@dataclass(frozen=True)
class ObjectTerm:
    term: str
    reading: str
    korean: str
    categories: tuple[str, ...]


@dataclass(frozen=True)
class ActionTerm:
    noun: str
    reading: str
    korean_noun: str
    korean_verb: str
    categories: tuple[str, ...]


OBJECTS: list[ObjectTerm] = [
    ObjectTerm("政策", "せいさく", "정책", ("planning", "legal")),
    ObjectTerm("制度", "せいど", "제도", ("planning", "legal")),
    ObjectTerm("計画", "けいかく", "계획", ("planning", "business")),
    ObjectTerm("方針", "ほうしん", "방침", ("planning", "legal")),
    ObjectTerm("予算", "よさん", "예산", ("planning", "business")),
    ObjectTerm("財政", "ざいせい", "재정", ("planning", "business")),
    ObjectTerm("税制", "ぜいせい", "세제", ("planning", "legal")),
    ObjectTerm("規制", "きせい", "규제", ("planning", "legal", "risk")),
    ObjectTerm("法案", "ほうあん", "법안", ("planning", "legal")),
    ObjectTerm("条約", "じょうやく", "조약", ("planning", "legal")),
    ObjectTerm("契約", "けいやく", "계약", ("planning", "business", "legal")),
    ObjectTerm("条件", "じょうけん", "조건", ("planning", "legal", "research")),
    ObjectTerm("基準", "きじゅん", "기준", ("planning", "business", "legal", "info")),
    ObjectTerm("指標", "しひょう", "지표", ("planning", "business", "research")),
    ObjectTerm("目標", "もくひょう", "목표", ("planning", "business")),
    ObjectTerm("目的", "もくてき", "목적", ("planning", "research")),
    ObjectTerm("優先順位", "ゆうせんじゅんい", "우선순위", ("planning", "business")),
    ObjectTerm("選択肢", "せんたくし", "선택지", ("planning", "research")),
    ObjectTerm("申請手続", "しんせいてつづき", "신청 절차", ("planning", "legal")),
    ObjectTerm("承認手順", "しょうにんてじゅん", "승인 절차", ("planning", "business", "legal")),
    ObjectTerm("業務手順", "ぎょうむてじゅん", "업무 절차", ("planning", "business", "info")),
    ObjectTerm("運用方針", "うんようほうしん", "운용 방침", ("planning", "system")),
    ObjectTerm("市場", "しじょう", "시장", ("business", "research")),
    ObjectTerm("需要", "じゅよう", "수요", ("business", "research")),
    ObjectTerm("供給", "きょうきゅう", "공급", ("business", "research")),
    ObjectTerm("価格", "かかく", "가격", ("business", "research")),
    ObjectTerm("利益", "りえき", "이익", ("business",)),
    ObjectTerm("損失", "そんしつ", "손실", ("business", "risk")),
    ObjectTerm("収益", "しゅうえき", "수익", ("business",)),
    ObjectTerm("費用", "ひよう", "비용", ("business",)),
    ObjectTerm("投資", "とうし", "투자", ("business", "planning")),
    ObjectTerm("資産", "しさん", "자산", ("business", "risk")),
    ObjectTerm("負債", "ふさい", "부채", ("business", "risk")),
    ObjectTerm("為替", "かわせ", "환율", ("business", "research")),
    ObjectTerm("金利", "きんり", "금리", ("business", "research")),
    ObjectTerm("取引", "とりひき", "거래", ("business", "legal")),
    ObjectTerm("交渉", "こうしょう", "협상", ("business", "legal", "planning")),
    ObjectTerm("在庫", "ざいこ", "재고", ("business", "info")),
    ObjectTerm("品質", "ひんしつ", "품질", ("business",)),
    ObjectTerm("納期", "のうき", "납기", ("business", "planning")),
    ObjectTerm("物流", "ぶつりゅう", "물류", ("business", "system")),
    ObjectTerm("販売計画", "はんばいけいかく", "판매 계획", ("business", "planning")),
    ObjectTerm("生産計画", "せいさんけいかく", "생산 계획", ("business", "planning", "system")),
    ObjectTerm("人材", "じんざい", "인재", ("business", "planning")),
    ObjectTerm("組織", "そしき", "조직", ("business", "planning", "system")),
    ObjectTerm("部門", "ぶもん", "부문", ("business", "planning")),
    ObjectTerm("責任範囲", "せきにんはんい", "책임 범위", ("business", "legal", "planning")),
    ObjectTerm("評判", "ひょうばん", "평판", ("business", "risk")),
    ObjectTerm("信用", "しんよう", "신용", ("business", "risk")),
    ObjectTerm("資料", "しりょう", "자료", ("info", "research", "business")),
    ObjectTerm("情報", "じょうほう", "정보", ("info", "business", "system")),
    ObjectTerm("統計", "とうけい", "통계", ("info", "research", "business")),
    ObjectTerm("記録", "きろく", "기록", ("info", "research", "legal")),
    ObjectTerm("証拠", "しょうこ", "증거", ("info", "legal", "risk")),
    ObjectTerm("報告書", "ほうこくしょ", "보고서", ("info", "business", "legal")),
    ObjectTerm("申請書", "しんせいしょ", "신청서", ("info", "legal")),
    ObjectTerm("証明書", "しょうめいしょ", "증명서", ("info", "legal")),
    ObjectTerm("契約書", "けいやくしょ", "계약서", ("info", "legal", "business")),
    ObjectTerm("議事録", "ぎじろく", "회의록", ("info", "business", "legal")),
    ObjectTerm("個人情報", "こじんじょうほう", "개인정보", ("info", "legal", "risk", "system")),
    ObjectTerm("機密情報", "きみつじょうほう", "기밀 정보", ("info", "legal", "risk", "system")),
    ObjectTerm("顧客情報", "こきゃくじょうほう", "고객 정보", ("info", "legal")),
    ObjectTerm("検索結果", "けんさくけっか", "검색 결과", ("info", "research", "system")),
    ObjectTerm("分類基準", "ぶんるいきじゅん", "분류 기준", ("info", "research", "planning")),
    ObjectTerm("保存形式", "ほぞんけいしき", "저장 형식", ("info", "system")),
    ObjectTerm("公開範囲", "こうかいはんい", "공개 범위", ("info", "legal", "planning")),
    ObjectTerm("通信記録", "つうしんきろく", "통신 기록", ("info", "system", "legal")),
    ObjectTerm("課題", "かだい", "과제", ("risk", "planning", "research")),
    ObjectTerm("問題", "もんだい", "문제", ("risk", "research", "planning")),
    ObjectTerm("対策", "たいさく", "대책", ("risk", "planning")),
    ObjectTerm("原因", "げんいん", "원인", ("risk", "research")),
    ObjectTerm("結果", "けっか", "결과", ("risk", "research", "business")),
    ObjectTerm("影響", "えいきょう", "영향", ("risk", "research", "business")),
    ObjectTerm("要因", "よういん", "요인", ("risk", "research")),
    ObjectTerm("可能性", "かのうせい", "가능성", ("risk", "research", "planning")),
    ObjectTerm("必要性", "ひつようせい", "필요성", ("risk", "planning", "research")),
    ObjectTerm("重要性", "じゅうようせい", "중요성", ("risk", "planning", "research")),
    ObjectTerm("有効性", "ゆうこうせい", "유효성", ("risk", "research", "business")),
    ObjectTerm("妥当性", "だとうせい", "타당성", ("risk", "research", "legal")),
    ObjectTerm("透明性", "とうめいせい", "투명성", ("risk", "legal", "business")),
    ObjectTerm("継続性", "けいぞくせい", "지속성", ("risk", "business", "planning")),
    ObjectTerm("専門性", "せんもんせい", "전문성", ("business", "research")),
    ObjectTerm("信頼性", "しんらいせい", "신뢰성", ("risk", "business")),
    ObjectTerm("安全性", "あんぜんせい", "안전성", ("risk", "research")),
    ObjectTerm("危険性", "きけんせい", "위험성", ("risk", "research")),
    ObjectTerm("脆弱性", "ぜいじゃくせい", "취약성", ("risk", "system")),
    ObjectTerm("障害", "しょうがい", "장애", ("risk", "system")),
    ObjectTerm("負荷", "ふか", "부하", ("risk", "system", "business")),
    ObjectTerm("容量", "ようりょう", "용량", ("system", "business")),
    ObjectTerm("通信", "つうしん", "통신", ("system", "info")),
    ObjectTerm("認証", "にんしょう", "인증", ("system", "legal")),
    ObjectTerm("設定", "せってい", "설정", ("system", "info")),
    ObjectTerm("設計", "せっけい", "설계", ("system", "planning")),
    ObjectTerm("構成", "こうせい", "구성", ("system", "info")),
    ObjectTerm("仕様", "しよう", "사양", ("system", "planning", "info")),
    ObjectTerm("実装", "じっそう", "구현", ("system",)),
    ObjectTerm("運用", "うんよう", "운용", ("system", "business", "planning")),
    ObjectTerm("保守", "ほしゅ", "보수", ("system", "business")),
    ObjectTerm("復旧", "ふっきゅう", "복구", ("system", "risk")),
    ObjectTerm("暗号化", "あんごうか", "암호화", ("system", "info", "risk")),
    ObjectTerm("権限", "けんげん", "권한", ("system", "legal", "info")),
    ObjectTerm("性能", "せいのう", "성능", ("research", "business")),
    ObjectTerm("精度", "せいど", "정확도", ("research", "business")),
    ObjectTerm("速度", "そくど", "속도", ("research", "business")),
    ObjectTerm("防御", "ぼうぎょ", "방어", ("system", "risk")),
    ObjectTerm("監査結果", "かんさけっか", "감사 결과", ("legal", "info")),
    ObjectTerm("安全基準", "あんぜんきじゅん", "안전 기준", ("system", "legal", "planning")),
    ObjectTerm("仮説", "かせつ", "가설", ("research",)),
    ObjectTerm("理論", "りろん", "이론", ("research",)),
    ObjectTerm("概念", "がいねん", "개념", ("research", "language")),
    ObjectTerm("定義", "ていぎ", "정의", ("research", "language", "legal")),
    ObjectTerm("傾向", "けいこう", "경향", ("research", "business", "risk")),
    ObjectTerm("研究", "けんきゅう", "연구", ("research", "planning")),
    ObjectTerm("調査", "ちょうさ", "조사", ("research", "planning")),
    ObjectTerm("実験", "じっけん", "실험", ("research", "risk")),
    ObjectTerm("観察", "かんさつ", "관찰", ("research",)),
    ObjectTerm("分析結果", "ぶんせきけっか", "분석 결과", ("research", "info", "business")),
    ObjectTerm("研究成果", "けんきゅうせいか", "연구 성과", ("research", "info")),
    ObjectTerm("論文", "ろんぶん", "논문", ("research", "info")),
    ObjectTerm("資料集", "しりょうしゅう", "자료집", ("research", "info")),
    ObjectTerm("文献", "ぶんけん", "문헌", ("research", "info")),
    ObjectTerm("症例", "しょうれい", "증례", ("research", "risk")),
    ObjectTerm("検査結果", "けんさけっか", "검사 결과", ("research", "info", "risk")),
    ObjectTerm("翻訳", "ほんやく", "번역", ("language", "info")),
    ObjectTerm("解釈", "かいしゃく", "해석", ("language", "research", "legal")),
    ObjectTerm("表現", "ひょうげん", "표현", ("language", "research")),
    ObjectTerm("文脈", "ぶんみゃく", "문맥", ("language", "research")),
    ObjectTerm("語彙", "ごい", "어휘", ("language", "research")),
    ObjectTerm("用法", "ようほう", "용법", ("language", "research")),
    ObjectTerm("表記", "ひょうき", "표기", ("language", "info")),
    ObjectTerm("発音", "はつおん", "발음", ("language", "research")),
    ObjectTerm("意味", "いみ", "의미", ("language", "research")),
    ObjectTerm("構文", "こうぶん", "구문", ("language", "research")),
    ObjectTerm("文章", "ぶんしょう", "문장", ("language", "info")),
    ObjectTerm("文化", "ぶんか", "문화", ("language", "research", "planning")),
    ObjectTerm("習慣", "しゅうかん", "습관", ("language", "research", "risk")),
    ObjectTerm("価値観", "かちかん", "가치관", ("language", "research")),
    ObjectTerm("環境", "かんきょう", "환경", ("environment", "planning", "risk")),
    ObjectTerm("気候", "きこう", "기후", ("environment", "research", "risk")),
    ObjectTerm("災害", "さいがい", "재해", ("environment", "risk", "planning")),
    ObjectTerm("避難計画", "ひなんけいかく", "대피 계획", ("environment", "risk", "planning")),
    ObjectTerm("交通網", "こうつうもう", "교통망", ("environment", "system", "planning")),
    ObjectTerm("電力", "でんりょく", "전력", ("environment", "system", "business")),
    ObjectTerm("燃料", "ねんりょう", "연료", ("environment", "business", "risk")),
    ObjectTerm("水資源", "みずしげん", "수자원", ("environment", "planning", "risk")),
    ObjectTerm("森林", "しんりん", "산림", ("environment", "research", "risk")),
    ObjectTerm("生態系", "せいたいけい", "생태계", ("environment", "research", "risk")),
    ObjectTerm("廃棄物", "はいきぶつ", "폐기물", ("environment", "risk", "business")),
    ObjectTerm("排出量", "はいしゅつりょう", "배출량", ("environment", "research", "business")),
    ObjectTerm("資源", "しげん", "자원", ("environment", "business", "planning")),
]


ACTIONS: list[ActionTerm] = [
    ActionTerm("分析", "ぶんせき", "분석", "분석하다", ("business", "info", "risk", "research", "language", "environment")),
    ActionTerm("検討", "けんとう", "검토", "검토하다", ("planning", "legal", "business", "risk", "environment")),
    ActionTerm("評価", "ひょうか", "평가", "평가하다", ("planning", "business", "risk", "research", "language", "system", "environment", "legal")),
    ActionTerm("改善", "かいぜん", "개선", "개선하다", ("planning", "business", "risk", "system", "language", "environment")),
    ActionTerm("調整", "ちょうせい", "조정", "조정하다", ("planning", "business", "system", "legal", "environment")),
    ActionTerm("管理", "かんり", "관리", "관리하다", ("planning", "business", "info", "risk", "system", "legal", "environment")),
    ActionTerm("確認", "かくにん", "확인", "확인하다", ("planning", "business", "info", "risk", "system", "legal", "research", "language", "environment")),
    ActionTerm("把握", "はあく", "파악", "파악하다", ("planning", "business", "risk", "research", "environment")),
    ActionTerm("比較", "ひかく", "비교", "비교하다", ("business", "research", "language", "risk", "environment")),
    ActionTerm("予測", "よそく", "예측", "예측하다", ("business", "risk", "research", "environment")),
    ActionTerm("推進", "すいしん", "추진", "추진하다", ("planning", "business", "environment")),
    ActionTerm("強化", "きょうか", "강화", "강화하다", ("planning", "business", "risk", "system", "environment")),
    ActionTerm("抑制", "よくせい", "억제", "억제하다", ("risk", "business", "environment")),
    ActionTerm("促進", "そくしん", "촉진", "촉진하다", ("business", "environment")),
    ActionTerm("維持", "いじ", "유지", "유지하다", ("business", "planning", "risk", "system", "environment")),
    ActionTerm("拡大", "かくだい", "확대", "확대하다", ("business", "planning", "system", "environment")),
    ActionTerm("縮小", "しゅくしょう", "축소", "축소하다", ("business", "planning", "environment")),
    ActionTerm("構築", "こうちく", "구축", "구축하다", ("system", "planning", "business", "info")),
    ActionTerm("導入", "どうにゅう", "도입", "도입하다", ("system", "planning", "business")),
    ActionTerm("運用", "うんよう", "운용", "운용하다", ("system", "planning", "business")),
    ActionTerm("監視", "かんし", "감시", "감시하다", ("system", "risk", "environment", "business")),
    ActionTerm("保護", "ほご", "보호", "보호하다", ("info", "risk", "system", "environment", "legal")),
    ActionTerm("活用", "かつよう", "활용", "활용하다", ("info", "business", "research", "language", "environment", "planning")),
    ActionTerm("公開", "こうかい", "공개", "공개하다", ("info", "research")),
    ActionTerm("保存", "ほぞん", "저장", "저장하다", ("info", "system")),
    ActionTerm("処理", "しょり", "처리", "처리하다", ("info", "system", "business")),
    ActionTerm("検証", "けんしょう", "검증", "검증하다", ("planning", "business", "info", "risk", "system", "legal", "research", "language", "environment")),
    ActionTerm("改定", "かいてい", "개정", "개정하다", ("planning", "legal", "info")),
    ActionTerm("共有", "きょうゆう", "공유", "공유하다", ("planning", "business", "info", "research", "language", "environment", "legal")),
    ActionTerm("記録", "きろく", "기록", "기록하다", ("info", "research", "risk", "system", "planning", "legal")),
    ActionTerm("整理", "せいり", "정리", "정리하다", ("info", "research", "language", "business", "planning")),
    ActionTerm("分類", "ぶんるい", "분류", "분류하다", ("info", "research", "language", "system")),
    ActionTerm("検索", "けんさく", "검색", "검색하다", ("info", "language", "system", "research")),
    ActionTerm("可視化", "かしか", "시각화", "시각화하다", ("business", "info", "risk", "research", "system", "environment")),
    ActionTerm("数値化", "すうちか", "수치화", "수치화하다", ("business", "info", "risk", "research", "environment")),
    ActionTerm("標準化", "ひょうじゅんか", "표준화", "표준화하다", ("planning", "business", "info", "system", "language", "legal")),
    ActionTerm("体系化", "たいけいか", "체계화", "체계화하다", ("planning", "info", "research", "language")),
    ActionTerm("明確化", "めいかくか", "명확화", "명확히 하다", ("planning", "legal", "risk", "language", "business")),
    ActionTerm("具体化", "ぐたいか", "구체화", "구체화하다", ("planning", "research", "language", "business")),
    ActionTerm("最適化", "さいてきか", "최적화", "최적화하다", ("business", "system", "planning", "environment")),
    ActionTerm("軽減", "けいげん", "경감", "경감하다", ("risk", "environment")),
    ActionTerm("防止", "ぼうし", "방지", "방지하다", ("risk", "system", "environment")),
    ActionTerm("復旧", "ふっきゅう", "복구", "복구하다", ("system", "environment")),
    ActionTerm("設計", "せっけい", "설계", "설계하다", ("system", "planning")),
    ActionTerm("調査", "ちょうさ", "조사", "조사하다", ("research", "risk", "business", "environment")),
    ActionTerm("観察", "かんさつ", "관찰", "관찰하다", ("research", "risk", "environment")),
    ActionTerm("翻訳", "ほんやく", "번역", "번역하다", ("language",)),
    ActionTerm("解釈", "かいしゃく", "해석", "해석하다", ("language", "research", "legal")),
]

CATEGORY_ACTIONS: dict[str, set[str]] = {
    "planning": {
        "検討", "評価", "改善", "調整", "管理", "確認", "把握", "比較", "予測",
        "推進", "強化", "抑制", "維持", "拡大", "縮小", "活用", "共有", "記録",
        "整理", "可視化", "数値化", "検証", "改定", "標準化", "体系化", "明確化",
        "具体化", "最適化",
    },
    "business": {
        "分析", "検討", "評価", "改善", "調整", "管理", "確認", "把握", "比較",
        "予測", "強化", "維持", "拡大", "縮小", "活用", "共有", "記録", "整理",
        "可視化", "数値化", "検証", "最適化", "調査",
    },
    "info": {
        "分析", "管理", "確認", "把握", "比較", "共有", "記録", "整理", "分類",
        "検索", "可視化", "数値化", "保護", "活用", "公開", "保存", "処理", "検証",
        "改定", "標準化", "体系化", "明確化",
    },
    "risk": {
        "分析", "検討", "評価", "改善", "管理", "確認", "把握", "比較", "予測",
        "抑制", "軽減", "防止", "監視", "共有", "記録", "整理", "分類", "可視化",
        "数値化", "検証", "明確化", "具体化", "調査", "観察",
    },
    "system": {
        "設計", "構築", "導入", "運用", "管理", "監視", "改善", "最適化", "標準化",
        "検証", "保護", "復旧", "確認", "記録", "調整", "処理", "分析", "評価",
        "可視化",
    },
    "legal": {
        "検討", "確認", "管理", "記録", "共有", "明確化", "標準化", "検証",
        "評価", "改定", "解釈", "整理", "保護",
    },
    "research": {
        "分析", "評価", "確認", "把握", "比較", "予測", "共有", "記録", "整理",
        "分類", "可視化", "数値化", "検証", "体系化", "具体化", "調査", "観察",
        "解釈",
    },
    "language": {
        "分析", "比較", "共有", "記録", "整理", "分類", "検索", "検証", "標準化",
        "体系化", "明確化", "具体化", "翻訳", "解釈", "活用",
    },
    "environment": {
        "分析", "検討", "評価", "改善", "調整", "管理", "確認", "把握", "比較",
        "予測", "推進", "強化", "抑制", "促進", "維持", "拡大", "縮小", "監視",
        "保護", "活用", "共有", "記録", "整理", "可視化", "数値化", "検証",
        "軽減", "防止", "復旧", "調査", "観察",
    },
}


HEADER = [
    "term",
    "reading",
    "meaning",
    "detail",
    "example",
    "exampleMeaning",
    "partOfSpeech",
]


def has_final_consonant(text: str) -> bool:
    for char in reversed(text):
        code = ord(char)
        if 0xAC00 <= code <= 0xD7A3:
            return (code - 0xAC00) % 28 != 0
    return False


def object_marker(korean: str) -> str:
    return "을" if has_final_consonant(korean) else "를"


def topic_marker(korean: str) -> str:
    return "은" if has_final_consonant(korean) else "는"


def past_verb(korean_verb: str) -> str:
    if korean_verb.endswith("하다"):
        return korean_verb[:-2] + "했다"
    return korean_verb + "했다"


def modifier_verb(korean_verb: str) -> str:
    if korean_verb.endswith("하다"):
        return korean_verb[:-2] + "하는"
    return korean_verb + "하는"


def declarative_verb(korean_verb: str) -> str:
    if korean_verb.endswith("하다"):
        return korean_verb[:-2] + "한다"
    return korean_verb + "한다"


def row_key(row: list[str]) -> str:
    return row[0]


def make_rows() -> list[list[str]]:
    rows: list[list[str]] = []
    seen_terms: set[str] = set()

    for obj in OBJECTS:
        allowed_actions = set()
        for category in obj.categories:
            allowed_actions.update(CATEGORY_ACTIONS[category])
        for action in ACTIONS:
            if obj.term == action.noun:
                continue
            if action.noun not in allowed_actions:
                continue

            particle = object_marker(obj.korean)
            action_past = f"{action.noun}した"
            korean_past = past_verb(action.korean_verb)
            korean_modifier = modifier_verb(action.korean_verb)
            korean_declarative = declarative_verb(action.korean_verb)

            compound_term = f"{obj.term}{action.noun}"
            if action.noun not in obj.term and compound_term not in seen_terms:
                rows.append(
                    [
                        compound_term,
                        f"{obj.reading}{action.reading}",
                        f"{obj.korean} {action.korean_noun}",
                        f"{obj.korean}{particle} {korean_modifier} 과정이나 결과를 가리키는 한자 복합 명사입니다.",
                        f"会議では{compound_term}の結果を共有した。",
                        f"회의에서는 {obj.korean} {action.korean_noun} 결과를 공유했다.",
                        "복합명사",
                    ]
                )
                seen_terms.add(compound_term)

            phrase_term = f"{obj.term}を{action.noun}する"
            if phrase_term not in seen_terms:
                rows.append(
                    [
                        phrase_term,
                        f"{obj.reading}を{action.reading}する",
                        f"{obj.korean}{particle} {action.korean_verb}",
                        f"{obj.korean}{particle} {korean_declarative}는 뜻의 한자 기반 동사구입니다. 업무, 연구, 정책, 기술 문맥에서 폭넓게 쓰일 수 있습니다.",
                        f"担当者は会議で{obj.term}を{action_past}。",
                        f"담당자는 회의에서 {obj.korean}{particle} {korean_past}.",
                        "동사구",
                    ]
                )
                seen_terms.add(phrase_term)

            nominal_term = f"{action.noun}対象"
            if len(rows) < 3200 and nominal_term not in seen_terms:
                rows.append(
                    [
                        nominal_term,
                        f"{action.reading}たいしょう",
                        f"{action.korean_noun} 대상",
                        f"{action.korean_noun} 대상이 되는 항목을 가리키는 한자 복합 명사입니다.",
                        f"{nominal_term}を一覧にまとめた。",
                        f"{action.korean_noun} 대상을 목록으로 정리했다.",
                        "복합명사",
                    ]
                )
                seen_terms.add(nominal_term)

    rows.sort(key=row_key)
    return rows


def main() -> None:
    rows = make_rows()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT.open("w", encoding="utf-8", newline="") as file:
        writer = csv.writer(file, delimiter="\t", lineterminator="\n")
        writer.writerow(HEADER)
        writer.writerows(rows)
    print(f"Wrote {len(rows)} rows to {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
