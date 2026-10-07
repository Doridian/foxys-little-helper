// Public blueprints from factorioprints.com. The site is backed by a publicly readable Firebase
// Realtime Database: /blueprintSummaries (title + favourites for every blueprint, ~3 MB),
// /blueprints/<key> (string, description, tags), /byTag/<tag> and /tags. There is no server-side
// search, so we cache the summaries and search titles here, like the site does in the browser.
//
// Titles, descriptions and tags are written by strangers: callers must treat them as data.

const DATABASE = "https://facorio-blueprints.firebaseio.com";
const SITE = "https://factorioprints.com/view";
const SUMMARY_TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 20_000;

export interface PrintSummary {
  key: string;
  title: string;
  favorites: number;
  updated?: number;
}

export interface PrintDetail {
  key: string;
  url: string;
  title: string;
  favorites: number;
  tags: string[];
  description: string;
  blueprintString: string;
  created?: number;
  updated?: number;
}

type Fetch = (url: string) => Promise<unknown>;

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "user-agent": "foxies-little-helper (Factorio helper bot)" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`factorioprints.com answered ${res.status}`);
  return res.json();
}

/** "[item=electronic-circuit] Green circuits!" -> ["electronic", "circuit", "green", "circuit"] */
export function titleWords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/\[(?:item|entity|fluid|recipe|technology|planet|virtual-signal|space-location|quality)=([^\]]+)\]/g, " $1 ")
    .split(/[^\p{L}\p{N}.]+/u)
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter((w) => w !== "")
    .map(stem);
}

const stem = (w: string) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/** What players say -> words that appear in titles. */
const SYNONYMS: Record<string, string[]> = {
  green: ["green", "electronic"],
  red: ["red", "advanced"],
  blue: ["blue", "processing"],
  chip: ["chip", "circuit"],
  gc: ["gc", "green"],
  rc: ["rc", "red"],
  lds: ["lds", "low"],
};

/**
 * Scores summaries against a query: each query word must start a title word (directly or via a
 * synonym); popular blueprints rank higher. Returns best first.
 */
export function searchSummaries(summaries: PrintSummary[], query: string, limit: number): PrintSummary[] {
  const words = titleWords(query).filter((w) => !STOPWORDS.has(w));
  const scored: { s: PrintSummary; score: number }[] = [];
  for (const s of summaries) {
    let score = 0;
    if (words.length > 0) {
      const title = titleWords(s.title);
      let hits = 0;
      let matched = 0;
      for (const w of words) {
        const options = SYNONYMS[w] ?? [w];
        if (options.some((o) => title.includes(o))) matched += 1;
        else if (options.some((o) => title.some((t) => t.startsWith(o)))) matched += 0.7;
        else continue;
        hits++;
      }
      // All words, or all but one of a long query.
      if (hits < words.length - (words.length >= 4 ? 1 : 0)) continue;
      score = (10 * matched) / words.length - title.length * 0.05;
    }
    score += 3 * Math.log10(1 + s.favorites);
    scored.push({ s, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.s);
}

const STOPWORDS = new Set(
  "a an and the of for to in with blueprint blueprints bp design build setup layout please find me some good".split(" "),
);

export class FactorioPrints {
  private summaries?: { at: number; list: Promise<PrintSummary[]> };
  private tags?: Promise<string[]>;
  private readonly byTag = new Map<string, Promise<Set<string>>>();

  constructor(private readonly get: Fetch = fetchJson) {}

  private allSummaries(): Promise<PrintSummary[]> {
    if (!this.summaries || Date.now() - this.summaries.at > SUMMARY_TTL_MS) {
      const list = this.get(`${DATABASE}/blueprintSummaries.json`).then((raw) =>
        Object.entries((raw ?? {}) as Record<string, { title?: string; numberOfFavorites?: number; lastUpdatedDate?: number }>).map(
          ([key, v]) => ({ key, title: v.title ?? "", favorites: v.numberOfFavorites ?? 0, updated: v.lastUpdatedDate }),
        ),
      );
      list.catch(() => (this.summaries = undefined));
      this.summaries = { at: Date.now(), list };
    }
    return this.summaries.list;
  }

  /** All tags as "/category/name/" paths, as blueprints carry them. */
  allTags(): Promise<string[]> {
    this.tags ??= this.get(`${DATABASE}/tags.json`).then((raw) =>
      Object.entries((raw ?? {}) as Record<string, string[]>).flatMap(([category, names]) => names.map((n) => `/${category}/${n}/`)),
    );
    this.tags.catch(() => (this.tags = undefined));
    return this.tags;
  }

  private async tagged(tag: string): Promise<Set<string>> {
    const tags = await this.allTags();
    const wanted = normalizeTag(tag);
    const match = tags.find((t) => t === wanted) ?? tags.find((t) => t.slice(1, -1).split("/")[1] === wanted.slice(1, -1));
    if (!match) {
      throw new Error(`Unknown tag '${tag}'. Tags: ${tags.filter((t) => !t.startsWith("/moderation/")).join(", ")}`);
    }
    let ids = this.byTag.get(match);
    if (!ids) {
      const path = match.slice(1, -1).split("/").map(encodeURIComponent).join("/");
      ids = this.get(`${DATABASE}/byTag/${path}.json?shallow=true`).then((raw) => new Set(Object.keys((raw ?? {}) as object)));
      ids.catch(() => this.byTag.delete(match));
      this.byTag.set(match, ids);
    }
    return ids;
  }

  async search(query: string, options: { tag?: string; limit?: number } = {}): Promise<PrintSummary[]> {
    let summaries = await this.allSummaries();
    if (options.tag) {
      const ids = await this.tagged(options.tag);
      summaries = summaries.filter((s) => ids.has(s.key));
    }
    return searchSummaries(summaries, query, options.limit ?? 10);
  }

  async detail(key: string): Promise<PrintDetail> {
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(key)) throw new Error(`'${key}' is not a factorioprints id`);
    const raw = (await this.get(`${DATABASE}/blueprints/${key}.json`)) as {
      title?: string;
      numberOfFavorites?: number;
      tags?: string[];
      descriptionMarkdown?: string;
      blueprintString?: string;
      createdDate?: number;
      lastUpdatedDate?: number;
    } | null;
    if (!raw?.blueprintString) throw new Error(`No blueprint '${key}' on factorioprints.com`);
    return {
      key,
      url: `${SITE}/${key}`,
      title: raw.title ?? "",
      favorites: raw.numberOfFavorites ?? 0,
      tags: (raw.tags ?? []).filter((t) => !t.startsWith("/moderation/")),
      description: raw.descriptionMarkdown ?? "",
      blueprintString: raw.blueprintString,
      created: raw.createdDate,
      updated: raw.lastUpdatedDate,
    };
  }
}

/** "electronic circuit (green)" or "/production/electronic circuit (green)/" -> "/production/electronic circuit (green)/" form. */
function normalizeTag(tag: string): string {
  const t = tag.trim().toLowerCase().replace(/^\/+|\/+$/g, "");
  return `/${t}/`;
}
