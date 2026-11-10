import type { LeaderboardRow, StoredChange, TileBundle } from "@seeearth/core";

export const API = (import.meta.env.VITE_API as string | undefined) ?? "";
export const REPO_URL = "https://github.com/seeEarth/seeearth";

export async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

export const fetchTile = (key: string) => getJSON<TileBundle>(`/api/tiles/${key}`);
export const fetchLeaderboard = () => getJSON<LeaderboardRow[]>("/api/leaderboard");
export const fetchStats = () => getJSON<Record<string, number>>("/api/stats");
export const fetchHistory = (target: string) => getJSON<(StoredChange & { status: string })[]>(`/api/features/${encodeURIComponent(target)}/history`);

export async function sendReport(form: FormData) {
  const r = await fetch(API + "/api/reports", { method: "POST", body: form });
  const j: any = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j as { id: number; tile: string };
}

export async function geocode(q: string): Promise<{ lon: number; lat: number; name: string } | null> {
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
  const j: any = await r.json();
  return j[0] ? { lon: Number(j[0].lon), lat: Number(j[0].lat), name: j[0].display_name } : null;
}
