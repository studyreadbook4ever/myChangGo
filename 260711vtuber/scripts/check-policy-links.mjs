import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const policyPath = path.join(root, "extension", "knowledge", "default-creator-policy.md");
const policy = await readFile(policyPath, "utf8");
const links = [...new Set(policy.match(/https:\/\/cafe\.naver\.com\/[A-Za-z0-9_-]+\/\d+/g) ?? [])];

if (links.length === 0) {
  console.error("정책 파일에서 네이버 카페 게시글 링크를 찾지 못했습니다.");
  process.exit(1);
}

const decodeEntities = (value) => value
  .replaceAll("&amp;", "&")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">")
  .replaceAll("&quot;", "\"")
  .replaceAll("&#39;", "'")
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));

const stripTags = (value) => decodeEntities(value)
  .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim();

async function fetchHtml(url) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "accept-language": "ko-KR,ko;q=0.9,en;q=0.7",
      "user-agent": "Mozilla/5.0 (compatible; ChzzkKirinukiPolicyAudit/1.0)"
    }
  });
  const bytes = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") ?? "";
  const declaredCharset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]?.toLowerCase();
  const charset = declaredCharset === "ms949" || declaredCharset === "cp949" ? "euc-kr" : (declaredCharset || "utf-8");
  let html;
  try {
    html = new TextDecoder(charset).decode(bytes);
  } catch {
    html = new TextDecoder("utf-8").decode(bytes);
  }
  return { response, html, byteLength: bytes.byteLength };
}

const firstMatch = (text, expressions) => {
  for (const expression of expressions) {
    const match = text.match(expression);
    if (match) {
      return match[1];
    }
  }
  return "";
};

async function auditLink(url) {
  const expectedArticleId = new URL(url).pathname.split("/").filter(Boolean).at(-1);
  const outer = await fetchHtml(url);
  const title = stripTags(outer.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") || "제목 미확인";
  const mainFrameQuery = outer.html.match(/(?:\$\(["']cafe_main["']\)|document\.getElementById\(["']cafe_main["']\))\.src\s*=\s*["'][^"']*ArticleRead\.nhn\?([^"']+)/i)?.[1] ?? "";
  const mainFrameParams = new URLSearchParams(decodeEntities(mainFrameQuery).replaceAll("\\u0026", "&"));
  const clubId = mainFrameParams.get("clubid") || firstMatch(outer.html, [
    /[?&]clubid=(\d+)/i,
    /["']clubid["']\s*[:=]\s*["']?(\d+)/i,
    /clubid\\?u?0026?[^\d]*(\d+)/i
  ]);
  const observedArticleId = mainFrameParams.get("articleid") || firstMatch(outer.html, [
    /[?&]articleid=(\d+)/i,
    /["']articleid["']\s*[:=]\s*["']?(\d+)/i
  ]) || expectedArticleId;

  let bodyAccess = "ARTICLE_ENDPOINT_NOT_FOUND";
  let bodyBytes = 0;
  if (clubId) {
    const articleUrl = `https://cafe.naver.com/ArticleRead.nhn?clubid=${clubId}&articleid=${expectedArticleId}`;
    const article = await fetchHtml(articleUrl);
    bodyBytes = article.byteLength;
    const visibleText = stripTags(article.html);
    const isJsShell = /id=["']app["']/i.test(article.html) && /<script\b/i.test(article.html);
    const isLogin = /로그인|nidlogin|accounts\.naver\.com/i.test(visibleText) || /nidlogin/i.test(article.html);
    if (!article.response.ok) {
      bodyAccess = `ARTICLE_HTTP_${article.response.status}`;
    } else if (isLogin) {
      bodyAccess = "LOGIN_REQUIRED";
    } else if (isJsShell || visibleText.length < 120) {
      bodyAccess = "JAVASCRIPT_SHELL_SOURCE_UNREADABLE";
    } else {
      bodyAccess = "BODY_TEXT_AVAILABLE_MANUAL_VERIFICATION_REQUIRED";
    }
  }

  const identityMatches = outer.response.ok && observedArticleId === expectedArticleId;
  return {
    url,
    outerStatus: outer.response.status,
    outerBytes: outer.byteLength,
    title,
    clubId: clubId || "미확인",
    expectedArticleId,
    observedArticleId,
    identityMatches,
    bodyAccess,
    bodyBytes
  };
}

const results = await Promise.all(links.map(async (link) => {
  try {
    return await auditLink(link);
  } catch (error) {
    return {
      url: link,
      outerStatus: "ERROR",
      outerBytes: 0,
      title: "접근 실패",
      clubId: "미확인",
      expectedArticleId: new URL(link).pathname.split("/").filter(Boolean).at(-1),
      observedArticleId: "미확인",
      identityMatches: false,
      bodyAccess: `${error.name}: ${error.message}`,
      bodyBytes: 0
    };
  }
}));

for (const result of results) {
  console.log(`\n${result.url}`);
  console.log(`  카페/페이지: ${result.title}`);
  console.log(`  외부 페이지: HTTP ${result.outerStatus}, ${result.outerBytes} bytes`);
  console.log(`  식별자: club ${result.clubId}, article ${result.observedArticleId} (expected ${result.expectedArticleId})`);
  console.log(`  정책 본문: ${result.bodyAccess}, ${result.bodyBytes} bytes`);
  console.log(`  링크 식별: ${result.identityMatches ? "MATCH" : "MISMATCH"}`);
}

const matched = results.filter((result) => result.identityMatches).length;
const readable = results.filter((result) => result.bodyAccess === "BODY_TEXT_AVAILABLE_MANUAL_VERIFICATION_REQUIRED").length;
console.log(`\n요약: ${links.length}개 중 링크 식별 ${matched}개 일치, 자동 본문 후보 ${readable}개.`);
console.log("주의: 본문 후보가 보여도 게시자·게시일·핵심 조항을 사람이 대조하기 전에는 VERIFIED가 아닙니다.");

if (matched !== links.length) {
  process.exitCode = 1;
}
