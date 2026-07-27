/*
 * Original, fictional records generated deterministically for the efchSQL demo.
 * No external dataset, user content, or outbound network request is involved.
 */

export const DEMO_TOPICS = Object.freeze([
  { symbol: "systems", label: "Small systems", short: "Systems", color: "#315a4e", initial: 2.4 },
  { symbol: "science", label: "Everyday science", short: "Science", color: "#4c568a", initial: 1.7 },
  { symbol: "local", label: "Local life", short: "Local", color: "#9a603f", initial: 1.25 },
  { symbol: "design", label: "Useful design", short: "Design", color: "#8a4d6d", initial: 0.8 },
  { symbol: "food", label: "Food & craft", short: "Food", color: "#9b6f20", initial: 0.35 },
  { symbol: "climate", label: "Climate practice", short: "Climate", color: "#39747b", initial: 1.05 },
  { symbol: "hype", label: "Trend noise", short: "Hype", color: "#82535a", initial: -1.8 },
]);

export const INITIAL_WEIGHTS = Object.freeze(
  Object.fromEntries(DEMO_TOPICS.map((topic) => [topic.symbol, topic.initial])),
);

const AUTHORS = [
  ["Mina Park", "minamakes"],
  ["Theo Vale", "theovale"],
  ["June Sol", "junesol"],
  ["Nari Finch", "narifinch"],
  ["Owen Rye", "owenrye"],
  ["Sora Bell", "sorabell"],
  ["Ivo Moon", "ivomoon"],
  ["Rhea Moss", "rheamoss"],
  ["Noa Field", "noafield"],
  ["Ari Lane", "arilane"],
  ["Eun River", "eunriver"],
  ["Toma Reed", "tomareed"],
  ["Mara Lin", "maralin"],
  ["Leo North", "leonorth"],
  ["Yuna Grove", "yunagrove"],
  ["Remy Cho", "remycho"],
];

const TOPIC_RECIPES = Object.freeze({
  systems: {
    secondary: ["science", "design", "local", "climate"],
    openings: [
      "A tiny queue taught me more about latency than a week of dashboards.",
      "The useful part of an index is the work it proves you can skip.",
      "Today’s small systems win: fewer moving pieces, clearer failure modes.",
      "I replaced a clever pipeline with one bounded heap and a visible counter.",
      "A fast query is nice. A query that can explain what it did not touch is better.",
      "The most calming performance chart is often the one with less machinery behind it.",
    ],
    details: [
      "The whole experiment fits in a browser tab and still agrees with the exhaustive result.",
      "Changing the preference vector reuses the same blocks; only the order of attention changes.",
      "It is not magic speed—just a safe upper bound doing honest bookkeeping.",
      "The result was easier to test because every tie has a stable, boring rule.",
    ],
  },
  science: {
    secondary: ["systems", "climate", "design", "local"],
    openings: [
      "A kitchen scale and ten quiet measurements can make a surprisingly good afternoon.",
      "Small experiments become useful when the stopping rule is written down first.",
      "Today I learned that uncertainty feels friendlier when it gets its own column.",
      "The neighborhood weather sensor disagreed with the forecast in one interesting place.",
      "A good chart should reveal the awkward data point instead of decorating around it.",
      "Replication is a social habit as much as a technical one.",
    ],
    details: [
      "I kept the raw readings, the failed attempt, and the question I would ask next.",
      "Nothing here needs a cloud model; a median and a careful note carried most of the value.",
      "The pattern is modest, but it is measurable and easy for someone else to check.",
      "The best part was turning a vague hunch into a result with visible limits.",
    ],
  },
  local: {
    secondary: ["food", "climate", "design", "science"],
    openings: [
      "The corner repair table saved four lamps from becoming four new purchases.",
      "A hand-drawn shade map made today’s walk cooler and three minutes shorter.",
      "The library’s smallest noticeboard keeps producing the best weekend plans.",
      "Someone added a bench beside the steep block, and the street immediately felt closer.",
      "Our market now labels the hour when each stall discounts what is left.",
      "A shared tool shelf is not glamorous, but it has already prevented six duplicate drills.",
    ],
    details: [
      "The useful information was distance, opening time, and one recent neighbor update.",
      "It is a tiny optimization, measured in coins and a little less wasted motion.",
      "No recommendation model was needed—just current context and a preference that could move.",
      "I wrote down the route so the next person can improve it instead of starting over.",
    ],
  },
  design: {
    secondary: ["systems", "local", "science", "food"],
    openings: [
      "A settings screen should show the consequence beside the control, not three screens later.",
      "Today’s interface rule: keep the receipt for every automatic decision.",
      "The best empty state I saw this week offered one clear next move and then got out of the way.",
      "A slider became understandable as soon as we labeled both ends with real outcomes.",
      "Good defaults are a form of hospitality, but they should never hide the exit.",
      "A loading state can tell the truth without making the page feel nervous.",
    ],
    details: [
      "The revision removed two icons, one modal, and a sentence that was doing no work.",
      "Keyboard focus now follows the same story as the visual layout.",
      "The small win was not prettier pixels; it was one fewer moment of uncertainty.",
      "The prototype uses system type, plain shapes, and no asset that needs to phone home.",
    ],
  },
  food: {
    secondary: ["local", "science", "climate", "design"],
    openings: [
      "The best use for yesterday’s rice might be a hot pan and five patient minutes.",
      "A market box becomes much easier when ingredients are ranked by what spoils first.",
      "I tested three ways to keep herbs alive; the least elaborate one won.",
      "Today’s soup cost less because the recipe followed the shelf, not the other way around.",
      "One reusable jar, one clear label, and suddenly the back of the fridge has a memory.",
      "A neighborhood baker shared the timing mistake that made the next batch better.",
    ],
    details: [
      "The note includes weight, time, and the version that did not quite work.",
      "It saved a purchase and turned a leftover into something I would deliberately make again.",
      "The useful metric was not perfection; it was how little ended up in the bin.",
      "Every ingredient is ordinary, and the method leaves room for whatever is already nearby.",
    ],
  },
  climate: {
    secondary: ["local", "science", "systems", "design"],
    openings: [
      "We measured the apartment’s standby power before buying anything to fix it.",
      "The cooler route was not the shortest route, so I saved both for different afternoons.",
      "A simple timer cut the shared hallway lights without making the stairs feel less safe.",
      "The repair café tracks avoided purchases, but also the repairs that did not hold.",
      "A refill station is only useful when its opening hours are more reliable than the packaging.",
      "The balcony shade worked better after we logged when the sun actually crossed the window.",
    ],
    details: [
      "The change is small enough to repeat and concrete enough to verify next month.",
      "We counted the extra effort too; savings that depend on invisible labor are not free.",
      "The useful result came from combining a local observation with one cheap calculation.",
      "No heroic lifestyle required—just a default that wastes a little less.",
    ],
  },
  hype: {
    secondary: ["design", "systems", "food", "local"],
    openings: [
      "Seven urgent tricks everyone must copy before breakfast.",
      "I ranked today’s loudest predictions by the size of their punctuation.",
      "A mysterious shortcut promises to replace every tool you already understand.",
      "This week’s miracle workflow has twelve steps and no stated problem.",
      "The trend chart goes straight up, provided we begin exactly where the line already rises.",
      "An important announcement about an announcement is apparently arriving soon.",
    ],
    details: [
      "The details are hidden behind a countdown, three badges, and a remarkably vague promise.",
      "There is no baseline, but there is a very confident arrow.",
      "The claim gets bigger each time the evidence gets smaller.",
      "I am saving the screenshot so we can compare it with the quieter outcome later.",
    ],
  },
});

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hashText(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function initials(name) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function makeRecord(primary, index, absoluteIndex) {
  const recipe = TOPIC_RECIPES[primary];
  const random = mulberry32(hashText(`${primary}:${index}:efchSQL`));
  const author = AUTHORS[(absoluteIndex * 7 + Math.floor(random() * AUTHORS.length)) % AUTHORS.length];
  // Keep 32-row neighborhoods thematically coherent. This gives the engine
  // tight block bounds while every individual post remains distinct.
  const secondary = recipe.secondary[Math.floor(index / 32) % recipe.secondary.length];
  const opening = recipe.openings[(index * 5 + Math.floor(random() * recipe.openings.length)) % recipe.openings.length];
  const detail = recipe.details[(index * 3 + Math.floor(random() * recipe.details.length)) % recipe.details.length];
  const id = `post-${String(absoluteIndex + 1).padStart(4, "0")}`;
  const ageHours = 1 + ((index * 11 + absoluteIndex * 3) % 144);
  const quality = 0.15 + random() * 0.55;
  const freshness = Math.max(0, 1 - ageHours / 180);
  const baseScore = Number((quality + freshness * 0.35 + (index % 9) * 0.003).toFixed(6));

  return Object.freeze({
    id,
    author: author[0],
    handle: `${author[1]}${String((absoluteIndex % 17) + 1).padStart(2, "0")}`,
    initials: initials(author[0]),
    body: `${opening} ${detail}`,
    language: "en",
    ageHours,
    createdLabel: ageHours < 24 ? `${ageHours}h` : `${Math.floor(ageHours / 24)}d`,
    symbols: Object.freeze([primary, secondary, `item/${id}`]),
    primary,
    secondary,
    baseScore,
    bias: baseScore,
    accent: (absoluteIndex * 3 + index) % 8,
    stats: Object.freeze({
      replies: 1 + Math.floor(random() * 36),
      echoes: Math.floor(random() * 92),
      likes: 4 + Math.floor(random() * 480),
    }),
  });
}

function buildRows(perTopic = 192) {
  const topics = Object.keys(TOPIC_RECIPES);
  const rows = [];
  for (const topic of topics) {
    for (let index = 0; index < perTopic; index += 1) {
      rows.push(makeRecord(topic, index, rows.length));
    }
  }
  return rows;
}

export const DEMO_ROWS = Object.freeze(buildRows());

const RESERVED_PREFERENCE_WORDS = new Set([
  "AND",
  "LIMIT",
  "MODE",
  "OR",
  "PREFER",
  "WHERE",
]);

function formatPreferenceSymbol(symbol) {
  const value = String(symbol);
  const isBareIdentifier = /^[\p{L}_$#@][\p{L}\p{N}_.$#@/\-]*$/u.test(value);
  if (isBareIdentifier && !RESERVED_PREFERENCE_WORDS.has(value.toUpperCase())) return value;
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '""');
  return `"${escaped}"`;
}

export function formatPreferenceClause(weights) {
  const clause = Object.entries(weights)
    .filter(([, value]) => Number.isFinite(Number(value)) && Number(value) !== 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([symbol, value]) =>
        `${formatPreferenceSymbol(symbol)}: ${Number(value).toFixed(2).replace(/\.?0+$/, "")}`,
    )
    .join(", ");
  return clause || "systems: 0";
}

export function buildDemoQuery(weights = INITIAL_WEIGHTS, mode = "exact", limit = 12) {
  const modeClause = mode === "budget" ? "MODE BUDGET 192" : "MODE EXACT";
  return [
    "SELECT * FROM feed",
    "WHERE language = 'en' AND ageHours <= 96",
    `PREFER ${formatPreferenceClause(weights)}`,
    `LIMIT ${limit} ${modeClause}`,
  ].join("\n");
}
