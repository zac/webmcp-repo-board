const ADJECTIVES = [
  "able", "agile", "airy", "alert", "alive", "amber", "ample", "aqua", "arid", "avid", "awake", "azure",
  "balmy", "basic", "blue", "bold", "bright", "brisk", "broad", "brown", "calm", "candid", "cedar", "chic",
  "civil", "clean", "clear", "coral", "cozy", "crisp", "curly", "deep", "deft", "eager", "early", "even",
  "fair", "fast", "fine", "firm", "fleet", "focal", "free", "fresh", "gentle", "glad", "gold", "grand",
  "great", "green", "hale", "happy", "hardy", "hazy", "ideal", "ivory", "jolly", "keen", "kind", "light",
  "lilac", "lucid", "lucky", "lunar", "major", "mellow", "merry", "mild", "mint", "misty", "neat", "noble",
  "novel", "ocean", "olive", "opal", "open", "peach", "pearl", "pink", "plain", "plum", "plush", "prime",
  "proud", "pure", "quick", "quiet", "rare", "ready", "regal", "rich", "rosy", "round", "royal", "sage",
  "sandy", "sharp", "sleek", "smart", "smooth", "soft", "solar", "solid", "spare", "sunny", "sweet", "swift",
  "teal", "tidal", "tidy", "vivid", "warm", "white", "wild", "wise", "young", "zesty",
] as const;

const NOUNS = [
  "acorn", "alder", "ant", "apple", "ash", "aspen", "badger", "bay", "bear", "bee", "birch", "bird",
  "bloom", "brook", "buck", "cloud", "coast", "comet", "crane", "creek", "crow", "dawn", "deer", "dove",
  "dune", "eagle", "elm", "ember", "falcon", "fern", "field", "finch", "flame", "flora", "fox", "frost",
  "glade", "grove", "gull", "hare", "hawk", "hazel", "hill", "ibis", "isle", "jay", "kite", "lake",
  "lark", "leaf", "lynx", "maple", "marsh", "moon", "moss", "moth", "mouse", "oak", "ocean", "otter",
  "owl", "panda", "peach", "pine", "plume", "pond", "quail", "rain", "raven", "reed", "reef", "ridge",
  "river", "robin", "rock", "rook", "rose", "sage", "seal", "sky", "slate", "snail", "snow", "star",
  "stone", "storm", "sun", "swan", "tern", "thorn", "tiger", "trail", "trout", "tulip", "vale", "vine",
  "whale", "wolf", "wren", "yew",
] as const;

export const TASK_REFERENCE_CAPACITY = ADJECTIVES.length * NOUNS.length;

export function taskReferenceCandidate(seed: string, attempt = 0): string {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= TASK_REFERENCE_CAPACITY) throw new RangeError("Task reference attempt is out of range");
  const index = (hash(seed) + attempt) % TASK_REFERENCE_CAPACITY;
  return `${ADJECTIVES[Math.floor(index / NOUNS.length)]}-${NOUNS[index % NOUNS.length]}`;
}

export function normalizeTaskReference(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export function isTaskReference(value: string): boolean {
  return /^[a-z]{3,6}-[a-z]{3,6}$/.test(normalizeTaskReference(value));
}

function hash(value: string): number {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return result >>> 0;
}
