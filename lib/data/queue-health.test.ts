import { describe, expect, it } from "vitest";
import {
  awaitingAutoSaveCount, isStuck, stuckCount, type QueueHealthLiveRow,
} from "./queue-health";

const NOW = Date.parse("2026-08-06T12:00:00Z");

function row(overrides: Partial<QueueHealthLiveRow>): QueueHealthLiveRow {
  return {
    org_id: "org-1", org_name: "SMEM", status: "queued", processing_mode: "batch",
    job_count: 1, oldest_at: null, max_attempt_count: 1, awaiting_auto_save: 0,
    ...overrides,
  };
}

const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60 * 1000).toISOString();

describe("isStuck", () => {
  it("queued : bloqué au-delà de 15 minutes, pas avant", () => {
    expect(isStuck(row({ status: "queued", oldest_at: minutesAgo(10) }), NOW)).toBe(false);
    expect(isStuck(row({ status: "queued", oldest_at: minutesAgo(20) }), NOW)).toBe(true);
  });

  it("batched : seuil large (3 h), le fournisseur peut être lent sans être en panne", () => {
    expect(isStuck(row({ status: "batched", oldest_at: minutesAgo(120) }), NOW)).toBe(false);
    expect(isStuck(row({ status: "batched", oldest_at: minutesAgo(200) }), NOW)).toBe(true);
  });

  it("needs_review n'est jamais bloqué : il attend l'humain par design", () => {
    expect(isStuck(row({ status: "needs_review", oldest_at: minutesAgo(10_000) }), NOW)).toBe(false);
  });

  it("sans horodatage : pas bloqué", () => {
    expect(isStuck(row({ oldest_at: null }), NOW)).toBe(false);
  });
});

describe("stuckCount", () => {
  it("somme les lignes bloquées, ignore needs_review", () => {
    const live = [
      row({ status: "queued", oldest_at: minutesAgo(30), job_count: 3 }),
      row({ status: "queued", oldest_at: minutesAgo(5), job_count: 7 }),
      row({ status: "needs_review", oldest_at: minutesAgo(10_000), job_count: 50 }),
    ];
    expect(stuckCount(live, NOW)).toBe(3);
  });
});

describe("awaitingAutoSaveCount", () => {
  it("compte les needs_review non examinés depuis plus de 10 minutes", () => {
    const live = [
      row({ status: "needs_review", awaiting_auto_save: 4, oldest_at: minutesAgo(30) }),
      row({ status: "needs_review", awaiting_auto_save: 2, oldest_at: minutesAgo(3) }),
      row({ status: "queued", awaiting_auto_save: 0, oldest_at: minutesAgo(30) }),
    ];
    // La ligne récente (3 min) est encore dans la fenêtre normale du Cron : pas comptée.
    expect(awaitingAutoSaveCount(live, NOW)).toBe(4);
  });
});
