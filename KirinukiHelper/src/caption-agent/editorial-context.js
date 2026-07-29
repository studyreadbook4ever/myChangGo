export const CAPTION_EDITORIAL_CONTEXT_SCHEMA =
  "kr-vtuber-editorial-context/v1";
export const MAX_CAPTION_GLOSSARY_ENTRIES = 48;
export const MAX_CAPTION_GLOSSARY_VARIANTS = 8;
export const MAX_CAPTION_SPEAKERS = 16;
export const MAX_CAPTION_SPEAKER_ALIASES = 12;
export const MAX_CAPTION_STYLE_EXAMPLES = 8;
export const MAX_CAPTION_EDITORIAL_CONTEXT_BYTES = 24 * 1024;

const PRIMARY_SPEAKER_ALIASES = Object.freeze([
  "host",
  "main",
  "primary",
  "speaker",
  "speaker-0",
  "speaker_0",
  "streamer",
  "unknown",
  "화자0",
  "화자-0",
  "화자_0"
]);

const HANGUL_INITIALS = Object.freeze([
  "g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss",
  "", "j", "jj", "ch", "k", "t", "p", "h"
]);
const HANGUL_MEDIALS = Object.freeze([
  "a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa",
  "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"
]);
const HANGUL_FINALS = Object.freeze([
  "", "k", "k", "ks", "n", "n", "nh", "t", "l", "lk", "lm",
  "lb", "ls", "lt", "lp", "lh", "m", "p", "ps", "t", "t", "ng",
  "t", "t", "k", "t", "p", "h"
]);

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}

function compactText(value, maximum) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

function uniqueBoundedStrings(values, maximumItems, maximumLength) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = compactText(value, maximumLength);
    const key = normalized.toLocaleLowerCase("ko-KR");
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
    if (result.length >= maximumItems) {
      break;
    }
  }
  return result;
}

export function romanizeHangulForIdentity(value) {
  let output = "";
  for (const character of String(value ?? "").normalize("NFKC")) {
    const codePoint = character.codePointAt(0);
    if (codePoint < 0xAC00 || codePoint > 0xD7A3) {
      output += character;
      continue;
    }
    const syllable = codePoint - 0xAC00;
    const initial = Math.floor(syllable / 588);
    const medial = Math.floor((syllable % 588) / 28);
    const final = syllable % 28;
    output += (
      HANGUL_INITIALS[initial]
      + HANGUL_MEDIALS[medial]
      + HANGUL_FINALS[final]
    );
  }
  return output;
}

function identityKey(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function speakerIdentityKeys(value) {
  const direct = identityKey(value);
  const romanized = identityKey(romanizeHangulForIdentity(value));
  return [...new Set([direct, romanized].filter(Boolean))];
}

function aliasesIntersect(left, right) {
  const rightKeys = new Set(right.flatMap(speakerIdentityKeys));
  return left.some((alias) => (
    speakerIdentityKeys(alias).some((key) => rightKeys.has(key))
  ));
}

function strictObject(value, field, allowedFields) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const unknown = Object.keys(value).filter(
    (candidate) => !allowedFields.includes(candidate)
  );
  if (unknown.length > 0) {
    throw new TypeError(`${field} contains unsupported fields`);
  }
  return value;
}

export function normalizeCaptionEditorialContext(raw, {
  strict = false
} = {}) {
  if (raw == null || raw === "") {
    return {
      schema: CAPTION_EDITORIAL_CONTEXT_SCHEMA,
      glossary: [],
      speakers: [{
        id: "main",
        aliases: [...PRIMARY_SPEAKER_ALIASES]
      }],
      style: {
        terminalPeriod: "omit",
        placement: "bottom",
        maxWidthUnits: 20,
        examples: []
      }
    };
  }
  const source = strict
    ? strictObject(raw, "editorialContext", [
      "schema",
      "glossary",
      "speakers",
      "style"
    ])
    : isPlainObject(raw) ? raw : {};
  if (
    strict
    && source.schema !== CAPTION_EDITORIAL_CONTEXT_SCHEMA
  ) {
    throw new TypeError("editorialContext.schema is unsupported");
  }

  const rawGlossary = Array.isArray(source.glossary) ? source.glossary : [];
  if (strict && rawGlossary.length > MAX_CAPTION_GLOSSARY_ENTRIES) {
    throw new TypeError("editorialContext.glossary is too large");
  }
  const glossary = [];
  const glossaryKeys = new Set();
  for (const [index, rawEntry] of rawGlossary.entries()) {
    const entry = strict
      ? strictObject(rawEntry, `editorialContext.glossary.${index}`, [
        "term",
        "variants"
      ])
      : isPlainObject(rawEntry) ? rawEntry : {};
    const term = compactText(entry.term, 64);
    if (!term) {
      if (strict) {
        throw new TypeError("editorialContext glossary term is empty");
      }
      continue;
    }
    const key = term.toLocaleLowerCase("ko-KR");
    if (glossaryKeys.has(key)) {
      continue;
    }
    const variants = uniqueBoundedStrings(
      entry.variants,
      MAX_CAPTION_GLOSSARY_VARIANTS,
      64
    ).filter((variant) => variant.toLocaleLowerCase("ko-KR") !== key);
    if (
      strict
      && (
        !Array.isArray(entry.variants)
        || entry.variants.length > MAX_CAPTION_GLOSSARY_VARIANTS
      )
    ) {
      throw new TypeError("editorialContext glossary variants are invalid");
    }
    glossaryKeys.add(key);
    glossary.push({ term, variants });
    if (glossary.length >= MAX_CAPTION_GLOSSARY_ENTRIES) {
      break;
    }
  }

  const rawSpeakers = Array.isArray(source.speakers) ? source.speakers : [];
  if (strict && rawSpeakers.length > MAX_CAPTION_SPEAKERS) {
    throw new TypeError("editorialContext.speakers is too large");
  }
  const speakers = [];
  const speakerIds = new Set();
  for (const [index, rawSpeaker] of rawSpeakers.entries()) {
    const speaker = strict
      ? strictObject(rawSpeaker, `editorialContext.speakers.${index}`, [
        "id",
        "aliases"
      ])
      : isPlainObject(rawSpeaker) ? rawSpeaker : {};
    const id = compactText(speaker.id, 80).toLocaleLowerCase("ko-KR");
    if (!id) {
      if (strict) {
        throw new TypeError("editorialContext speaker id is empty");
      }
      continue;
    }
    if (
      strict
      && (
        !Array.isArray(speaker.aliases)
        || speaker.aliases.length > MAX_CAPTION_SPEAKER_ALIASES
      )
    ) {
      throw new TypeError("editorialContext speaker aliases are invalid");
    }
    if (speakerIds.has(id)) {
      continue;
    }
    speakerIds.add(id);
    speakers.push({
      id,
      aliases: uniqueBoundedStrings(
        [id, ...(Array.isArray(speaker.aliases) ? speaker.aliases : [])],
        MAX_CAPTION_SPEAKER_ALIASES,
        80
      )
    });
    if (speakers.length >= MAX_CAPTION_SPEAKERS) {
      break;
    }
  }
  const primaryAliases = uniqueBoundedStrings(
    [
      "main",
      ...(speakers.find(({ id }) => id === "main")?.aliases || []),
      ...PRIMARY_SPEAKER_ALIASES
    ],
    MAX_CAPTION_SPEAKER_ALIASES,
    80
  );
  const withoutMain = speakers.filter(({ id }) => id !== "main");
  speakers.splice(0, speakers.length, {
    id: "main",
    aliases: primaryAliases
  }, ...withoutMain);

  const styleSource = strict
    ? strictObject(source.style, "editorialContext.style", [
      "terminalPeriod",
      "placement",
      "maxWidthUnits",
      "examples"
    ])
    : isPlainObject(source.style) ? source.style : {};
  if (
    strict
    && (
      styleSource.terminalPeriod !== "omit"
      || styleSource.placement !== "bottom"
      || styleSource.maxWidthUnits !== 20
      || !Array.isArray(styleSource.examples)
      || styleSource.examples.length > MAX_CAPTION_STYLE_EXAMPLES
    )
  ) {
    throw new TypeError("editorialContext.style violates the caption contract");
  }
  const style = {
    terminalPeriod: "omit",
    placement: "bottom",
    maxWidthUnits: 20,
    examples: uniqueBoundedStrings(
      styleSource.examples,
      MAX_CAPTION_STYLE_EXAMPLES,
      80
    )
  };

  const normalized = {
    schema: CAPTION_EDITORIAL_CONTEXT_SCHEMA,
    glossary,
    speakers,
    style
  };
  if (
    new TextEncoder().encode(JSON.stringify(normalized)).byteLength
    > MAX_CAPTION_EDITORIAL_CONTEXT_BYTES
  ) {
    throw new TypeError("editorialContext exceeds its byte limit");
  }
  return normalized;
}

export function canonicalCaptionSpeakerId(value, editorialContext) {
  const candidate = compactText(value, 80).toLocaleLowerCase("ko-KR")
    || "unknown";
  const context = normalizeCaptionEditorialContext(editorialContext);
  const candidateKeys = new Set(speakerIdentityKeys(candidate));
  for (const speaker of context.speakers) {
    if (
      [speaker.id, ...speaker.aliases]
        .flatMap(speakerIdentityKeys)
        .some((key) => candidateKeys.has(key))
    ) {
      return speaker.id;
    }
  }
  return PRIMARY_SPEAKER_ALIASES.includes(candidate)
    ? "main"
    : candidate;
}

function captionSpeakerId(cue) {
  return compactText(
    cue?.remoteMeta?.speakerId
    ?? cue?.speakerId
    ?? cue?.speaker,
    80
  ).toLocaleLowerCase("ko-KR");
}

function captionText(cue) {
  return compactText(cue?.text, 80)
    .replace(/[.\u3002\uff0e]+$/gu, "")
    .trim();
}

function projectTimelineOrder(project, cue) {
  const clipIndex = (project?.clips || []).findIndex(
    (clip) => clip?.id === cue?.clipId
  );
  return (
    Math.max(0, clipIndex) * 10_000_000
    + Math.max(0, Number(cue?.startOffsetMs) || 0)
  );
}

function trustedStyleExamples(project) {
  return (Array.isArray(project?.subtitles) ? project.subtitles : [])
    .filter((cue) => (
      cue?.origin === "ai"
      && cue?.humanEdited === true
      && captionText(cue)
      && !/\[불명확\]/u.test(captionText(cue))
    ))
    .sort((first, second) => (
      projectTimelineOrder(project, first) - projectTimelineOrder(project, second)
    ))
    .map(captionText)
    .filter((text) => text.length <= 80);
}

function trustedGlossaryTerms(project) {
  const counts = new Map();
  for (const example of trustedStyleExamples(project)) {
    const tokens = example.match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,31}/gu) || [];
    for (const token of new Set(tokens)) {
      const key = token.toLocaleLowerCase("ko-KR");
      counts.set(key, {
        term: token,
        count: (counts.get(key)?.count || 0) + 1
      });
    }
  }
  return [...counts.values()]
    .filter(({ count }) => count >= 2)
    .sort((first, second) => (
      second.count - first.count
      || first.term.localeCompare(second.term, "ko")
    ))
    .map(({ term }) => ({ term, variants: [] }));
}

function explicitContext(project) {
  const raw = project?.ai?.captionContext;
  try {
    return normalizeCaptionEditorialContext(raw);
  } catch {
    return normalizeCaptionEditorialContext();
  }
}

export function buildProjectCaptionEditorialContext(project, {
  includeUnreviewedSpeakers = true
} = {}) {
  const explicit = explicitContext(project);
  const streamerName = compactText(project?.source?.streamerName, 120);
  const streamerAliases = uniqueBoundedStrings([
    streamerName,
    ...streamerName.split(/[\s·|/]+/gu),
    ...streamerName.split(/[\s·|/]+/gu).map(romanizeHangulForIdentity)
  ], MAX_CAPTION_SPEAKER_ALIASES, 80);
  const primaryAliases = uniqueBoundedStrings([
    "main",
    ...streamerAliases,
    ...(explicit.speakers.find(({ id }) => id === "main")?.aliases || []),
    ...PRIMARY_SPEAKER_ALIASES
  ], MAX_CAPTION_SPEAKER_ALIASES, 80);

  const speakerCounts = new Map();
  for (const cue of Array.isArray(project?.subtitles) ? project.subtitles : []) {
    if (
      !includeUnreviewedSpeakers
      && cue?.humanEdited !== true
      && cue?.origin !== "human"
    ) {
      continue;
    }
    const speakerId = captionSpeakerId(cue);
    if (speakerId) {
      speakerCounts.set(speakerId, (speakerCounts.get(speakerId) || 0) + 1);
    }
  }
  const speakers = [{
    id: "main",
    aliases: primaryAliases
  }];
  const explicitNonPrimary = explicit.speakers.filter(({ id }) => id !== "main");
  for (const speaker of explicitNonPrimary) {
    if (!aliasesIntersect(speaker.aliases, primaryAliases)) {
      speakers.push(speaker);
    }
  }
  for (const [speakerId] of [...speakerCounts.entries()].sort(
    (first, second) => second[1] - first[1] || first[0].localeCompare(second[0], "ko")
  )) {
    if (
      speakers.length >= MAX_CAPTION_SPEAKERS
      || speakers.some((speaker) => (
        aliasesIntersect([speakerId], [speaker.id, ...speaker.aliases])
      ))
    ) {
      continue;
    }
    if (aliasesIntersect([speakerId], primaryAliases)) {
      speakers[0].aliases = uniqueBoundedStrings(
        [...speakers[0].aliases, speakerId],
        MAX_CAPTION_SPEAKER_ALIASES,
        80
      );
      continue;
    }
    speakers.push({ id: speakerId, aliases: [speakerId] });
  }

  const projectTerms = [
    streamerName,
    ...streamerName.split(/[\s·|/]+/gu)
  ].filter((term) => term.length >= 2).map((term) => ({
    term,
    variants: []
  }));
  return normalizeCaptionEditorialContext({
    schema: CAPTION_EDITORIAL_CONTEXT_SCHEMA,
    glossary: [
      ...explicit.glossary,
      ...projectTerms,
      ...trustedGlossaryTerms(project)
    ],
    speakers,
    style: {
      terminalPeriod: "omit",
      placement: "bottom",
      maxWidthUnits: 20,
      examples: [
        ...explicit.style.examples,
        ...trustedStyleExamples(project)
      ]
    }
  });
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function captionEditorialContextFingerprint(editorialContext) {
  const bytes = new TextEncoder().encode(stableStringify(
    normalizeCaptionEditorialContext(editorialContext)
  ));
  let first = 0x811C9DC5;
  let second = 0x9E3779B9;
  for (const byte of bytes) {
    first = Math.imul(first ^ byte, 0x01000193) >>> 0;
    second = Math.imul(second ^ byte, 0x85EBCA6B) >>> 0;
  }
  return `ctx-v1-${first.toString(16).padStart(8, "0")}${second
    .toString(16).padStart(8, "0")}`;
}
