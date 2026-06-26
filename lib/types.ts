// Shared, client-safe types for API responses. This module imports NO secrets and
// no server-only code, so it's safe to import from client components.
//
// The discovery payload mirrors the on-disk snapshot JSON shape (one row per
// campaign) so the snapshot and live sources share a single renderer.
export type {
  PageIdSource,
  ReconcileStatus,
  CampaignRow,
  DiscoverySummary,
  DiscoverySource,
  DiscoveryResult,
  AccountInfo,
} from "@/lib/discovery/types";

import type { AccountInfo, ReconcileStatus } from "@/lib/discovery/types";

/**
 * Table/overview filter value. "ALL"; the store-list-only "SG" flag; the reconcile
 * "ACTIVE" (delivery) and tier filters "T1"/"T2"/"T3"; or a reconcile status.
 * Shared by the Dashboard and the SummaryBar.
 */
export type FilterValue =
  | ReconcileStatus
  | "ALL"
  | "SG"
  | "ACTIVE"
  | "T1"
  | "T2"
  | "T3";

/** GET /api/accounts response. */
export interface AccountsResponse {
  accounts: AccountInfo[];
  defaultSlug: string;
}

/**
 * GET /api/discovery?account=<slug> response. This is exactly the unified
 * DiscoveryResult (re-exported for symmetry with the rest of the API types).
 */
export type { DiscoveryResult as DiscoveryResponse } from "@/lib/discovery/types";

/** GET /api/health?account=<slug> response. */
export interface HealthResponse {
  ok: boolean;
  accountName: string | null;
  accountStatus: number | null;
  message: string;
}

/** Uniform API error body. */
export interface ApiError {
  error: string;
}
