/**
 * Deterministic seed data for every mocked backend system (CRM, Identity, OMS,
 * Payments, Policy repository, Case management). Nothing here is random —
 * scenario behavior must reproduce exactly the same way on every run so tests
 * and the evaluation harness stay deterministic.
 *
 * Scenario index (see README "Mock scenarios" table for the narrative form):
 *   1. cust_001 / ord_1001  - eligible low-value refund (autonomous)
 *   2. cust_002 / ord_1002  - unverified customer
 *   3. cust_003 / ord_1003  - high-value refund (mandatory escalation)
 *   4. cust_004 / ord_1004  - policy conflict (regional vs SKU hazmat)
 *   5. (no order)  ord_9999 - order not found
 *   6. cust_006 / ord_1006  - no previous refunds (valid empty result)
 *   7. cust_007 / ord_1007  - transient payment failure then success
 *   8. cust_008 / ord_1008  - retry exhaustion (always-failing gateway)
 *   9. cust_009 / ord_1009  - duplicate refund / idempotency replay
 *  10. cust_010 / ord_1010  - refund exceeding remaining paid balance
 *  11. cust_011 / ord_1011  - locked/risky account
 *  12. cust_012 / ord_1012  - stale policy (no currently-effective policy)
 *  13. cust_013 / ord_1013  - currency mismatch
 */

import { money, type Money } from "../domain/money.js";

export interface CustomerRecord {
  customerId: string;
  name: string;
  email: string;
  region: string;
  defaultCurrency: string;
  identityStatus: "unverified" | "verified" | "locked";
  /** The value that must be supplied to verify_customer_identity, e.g. zip code. */
  verificationAnswer: string;
  accountFlags: string[];
}

export interface LineItemRecord {
  sku: string;
  description: string;
  quantity: number;
  unitPrice: Money;
}

export interface OrderRecord {
  orderId: string;
  customerId: string;
  region: string;
  currency: string;
  status: "delivered" | "shipped" | "processing" | "cancelled";
  orderDate: string;
  deliveryDate: string | null;
  lineItems: LineItemRecord[];
  amountPaid: Money;
}

export interface PolicyDocument {
  policyId: string;
  version: string;
  title: string;
  region: string; // "ALL" or a specific region code
  skuScope: string; // "ALL" or a specific SKU/category token
  effectiveDate: string;
  expirationDate: string | null;
  returnWindowDays: number | null;
  returnable: boolean;
  precedence: number; // higher = more specific (sku > region > global)
  supersedes: string[]; // policyIds this document explicitly overrides on conflict
  excerpt: string;
  sourceFile: string;
}

export interface PaymentTransaction {
  transactionId: string;
  orderId: string;
  customerId: string;
  type: "charge" | "refund";
  amount: Money;
  idempotencyKey: string | null;
  createdAt: string;
}

export const customers: Record<string, CustomerRecord> = {
  cust_001: {
    customerId: "cust_001",
    name: "Ava Chen",
    email: "ava.chen@example.com",
    region: "US",
    defaultCurrency: "USD",
    identityStatus: "unverified",
    verificationAnswer: "94107",
    accountFlags: [],
  },
  cust_002: {
    customerId: "cust_002",
    name: "Ben Osei",
    email: "ben.osei@example.com",
    region: "US",
    defaultCurrency: "USD",
    identityStatus: "unverified",
    verificationAnswer: "60614",
    accountFlags: [],
  },
  cust_003: {
    customerId: "cust_003",
    name: "Carla Diaz",
    email: "carla.diaz@example.com",
    region: "US",
    defaultCurrency: "USD",
    identityStatus: "unverified",
    verificationAnswer: "73301",
    accountFlags: [],
  },
  cust_004: {
    customerId: "cust_004",
    name: "Daan Willems",
    email: "daan.willems@example.com",
    region: "EU",
    defaultCurrency: "EUR",
    identityStatus: "unverified",
    verificationAnswer: "1011AB",
    accountFlags: [],
  },
  cust_006: {
    customerId: "cust_006",
    name: "Freya Nilsen",
    email: "freya.nilsen@example.com",
    region: "US",
    defaultCurrency: "USD",
    identityStatus: "unverified",
    verificationAnswer: "10001",
    accountFlags: [],
  },
  cust_007: {
    customerId: "cust_007",
    name: "Grace Kim",
    email: "grace.kim@example.com",
    region: "US",
    defaultCurrency: "USD",
    identityStatus: "unverified",
    verificationAnswer: "94301",
    accountFlags: [],
  },
  cust_008: {
    customerId: "cust_008",
    name: "Hugo Fischer",
    email: "hugo.fischer@example.com",
    region: "US",
    defaultCurrency: "USD",
    identityStatus: "unverified",
    verificationAnswer: "10002",
    accountFlags: [],
  },
  cust_009: {
    customerId: "cust_009",
    name: "Ines Silva",
    email: "ines.silva@example.com",
    region: "US",
    defaultCurrency: "USD",
    identityStatus: "unverified",
    verificationAnswer: "10003",
    accountFlags: [],
  },
  cust_010: {
    customerId: "cust_010",
    name: "Jonas Berg",
    email: "jonas.berg@example.com",
    region: "US",
    defaultCurrency: "USD",
    identityStatus: "unverified",
    verificationAnswer: "10004",
    accountFlags: [],
  },
  cust_011: {
    customerId: "cust_011",
    name: "Kira Novak",
    email: "kira.novak@example.com",
    region: "US",
    defaultCurrency: "USD",
    identityStatus: "locked",
    verificationAnswer: "10005",
    accountFlags: ["fraud_review"],
  },
  cust_012: {
    customerId: "cust_012",
    name: "Liam O'Sullivan",
    email: "liam.osullivan@example.com",
    region: "US",
    defaultCurrency: "USD",
    identityStatus: "unverified",
    verificationAnswer: "10006",
    accountFlags: [],
  },
  cust_013: {
    customerId: "cust_013",
    name: "Mona Haddad",
    email: "mona.haddad@example.com",
    region: "US",
    defaultCurrency: "USD",
    identityStatus: "unverified",
    verificationAnswer: "10007",
    accountFlags: [],
  },
};

export const orders: Record<string, OrderRecord> = {
  ord_1001: {
    orderId: "ord_1001",
    customerId: "cust_001",
    region: "US",
    currency: "USD",
    status: "delivered",
    orderDate: "2026-07-20",
    deliveryDate: "2026-07-24",
    lineItems: [
      { sku: "HOME-MUG-01", description: "Ceramic travel mug", quantity: 1, unitPrice: money("45.00", "USD") },
    ],
    amountPaid: money("45.00", "USD"),
  },
  ord_1002: {
    orderId: "ord_1002",
    customerId: "cust_002",
    region: "US",
    currency: "USD",
    status: "delivered",
    orderDate: "2026-07-18",
    deliveryDate: "2026-07-22",
    lineItems: [
      { sku: "APPAREL-TEE-04", description: "Cotton t-shirt", quantity: 2, unitPrice: money("18.00", "USD") },
    ],
    amountPaid: money("36.00", "USD"),
  },
  ord_1003: {
    orderId: "ord_1003",
    customerId: "cust_003",
    region: "US",
    currency: "USD",
    status: "delivered",
    orderDate: "2026-07-10",
    deliveryDate: "2026-07-15",
    lineItems: [
      { sku: "ELEC-LAPTOP-11", description: "13-inch ultrabook", quantity: 1, unitPrice: money("799.99", "USD") },
    ],
    amountPaid: money("799.99", "USD"),
  },
  ord_1004: {
    orderId: "ord_1004",
    customerId: "cust_004",
    region: "EU",
    currency: "EUR",
    status: "delivered",
    orderDate: "2026-07-28",
    deliveryDate: "2026-07-30",
    lineItems: [
      {
        sku: "ELECTRONICS-DRONE",
        description: "Consumer quadcopter drone",
        quantity: 1,
        unitPrice: money("249.00", "EUR"),
      },
    ],
    amountPaid: money("249.00", "EUR"),
  },
  ord_1006: {
    orderId: "ord_1006",
    customerId: "cust_006",
    region: "US",
    currency: "USD",
    status: "delivered",
    orderDate: "2026-07-25",
    deliveryDate: "2026-07-28",
    lineItems: [
      { sku: "HOME-LAMP-02", description: "Desk lamp", quantity: 1, unitPrice: money("32.00", "USD") },
    ],
    amountPaid: money("32.00", "USD"),
  },
  ord_1007: {
    orderId: "ord_1007",
    customerId: "cust_007",
    region: "US",
    currency: "USD",
    status: "delivered",
    orderDate: "2026-07-26",
    deliveryDate: "2026-07-29",
    lineItems: [
      { sku: "HOME-MUG-01", description: "Ceramic travel mug", quantity: 1, unitPrice: money("60.00", "USD") },
    ],
    amountPaid: money("60.00", "USD"),
  },
  ord_1008: {
    orderId: "ord_1008",
    customerId: "cust_008",
    region: "US",
    currency: "USD",
    status: "delivered",
    orderDate: "2026-07-26",
    deliveryDate: "2026-07-29",
    lineItems: [
      { sku: "HOME-MUG-01", description: "Ceramic travel mug", quantity: 1, unitPrice: money("60.00", "USD") },
    ],
    amountPaid: money("60.00", "USD"),
  },
  ord_1009: {
    orderId: "ord_1009",
    customerId: "cust_009",
    region: "US",
    currency: "USD",
    status: "delivered",
    orderDate: "2026-07-15",
    deliveryDate: "2026-07-19",
    lineItems: [
      { sku: "APPAREL-TEE-04", description: "Cotton t-shirt", quantity: 4, unitPrice: money("20.00", "USD") },
    ],
    amountPaid: money("80.00", "USD"),
  },
  ord_1010: {
    orderId: "ord_1010",
    customerId: "cust_010",
    region: "US",
    currency: "USD",
    status: "delivered",
    orderDate: "2026-07-10",
    deliveryDate: "2026-07-14",
    lineItems: [
      { sku: "HOME-LAMP-02", description: "Desk lamp", quantity: 1, unitPrice: money("50.00", "USD") },
    ],
    amountPaid: money("50.00", "USD"),
  },
  ord_1011: {
    orderId: "ord_1011",
    customerId: "cust_011",
    region: "US",
    currency: "USD",
    status: "delivered",
    orderDate: "2026-07-20",
    deliveryDate: "2026-07-24",
    lineItems: [
      { sku: "ELEC-LAPTOP-11", description: "13-inch ultrabook", quantity: 1, unitPrice: money("799.99", "USD") },
    ],
    amountPaid: money("799.99", "USD"),
  },
  ord_1012: {
    orderId: "ord_1012",
    customerId: "cust_012",
    region: "US",
    currency: "USD",
    status: "delivered",
    orderDate: "2026-07-05",
    deliveryDate: "2026-07-09",
    lineItems: [
      {
        sku: "CLEARANCE-ITEM",
        description: "End-of-season clearance item",
        quantity: 1,
        unitPrice: money("40.00", "USD"),
      },
    ],
    amountPaid: money("40.00", "USD"),
  },
  ord_1013: {
    orderId: "ord_1013",
    customerId: "cust_013",
    region: "US",
    currency: "USD",
    status: "delivered",
    orderDate: "2026-07-20",
    deliveryDate: "2026-07-24",
    lineItems: [
      { sku: "HOME-MUG-01", description: "Ceramic travel mug", quantity: 1, unitPrice: money("45.00", "USD") },
    ],
    amountPaid: money("45.00", "USD"),
  },
};

/** SKU-specific and region-wide return policies. Global "ALL"/"ALL" is the fallback. */
export const policyCatalog: PolicyDocument[] = [
  {
    policyId: "POL-RETURN-GLOBAL",
    version: "3",
    title: "Global standard return policy",
    region: "ALL",
    skuScope: "ALL",
    effectiveDate: "2026-01-01",
    expirationDate: null,
    returnWindowDays: 30,
    returnable: true,
    precedence: 0,
    supersedes: [],
    excerpt:
      "Items may be returned within 30 days of delivery for a full refund unless a region- or " +
      "category-specific policy states otherwise.",
    sourceFile: "policies/global-standard-return.md",
  },
  {
    policyId: "POL-RETURN-EU",
    version: "2",
    title: "EU consumer return policy",
    region: "EU",
    skuScope: "ALL",
    effectiveDate: "2026-01-01",
    expirationDate: null,
    returnWindowDays: 14,
    returnable: true,
    precedence: 1,
    supersedes: ["POL-RETURN-GLOBAL"],
    excerpt:
      "Consistent with EU consumer-rights law, customers in EU regions may withdraw and return " +
      "items within 14 days of delivery for a full refund.",
    sourceFile: "policies/eu-consumer-return.md",
  },
  {
    policyId: "POL-DRONE-HAZMAT",
    version: "1",
    title: "Hazmat / restricted-shipping category return rule",
    region: "ALL",
    skuScope: "ELECTRONICS-DRONE",
    effectiveDate: "2025-06-01",
    expirationDate: null,
    returnWindowDays: null,
    returnable: false,
    precedence: 2,
    supersedes: [],
    excerpt:
      "Products classified as restricted-shipping (lithium battery / hazmat, including consumer " +
      "drones) are non-returnable once delivered, regardless of regional return windows, due to " +
      "carrier hazmat handling restrictions.",
    sourceFile: "policies/hazmat-restricted-shipping.md",
  },
  {
    policyId: "POL-CLEARANCE-2024",
    version: "1",
    title: "2024 clearance inventory return rule",
    region: "US",
    skuScope: "CLEARANCE-ITEM",
    effectiveDate: "2024-01-01",
    expirationDate: "2024-12-31",
    returnWindowDays: 7,
    returnable: true,
    precedence: 2,
    supersedes: [],
    excerpt:
      "2024 clearance inventory may be returned within 7 days of delivery. This policy expired " +
      "2024-12-31 and has not been renewed for subsequent clearance cycles.",
    sourceFile: "policies/clearance-2024.md",
  },
];

export const paymentTransactions: PaymentTransaction[] = [
  {
    transactionId: "txn_9001",
    orderId: "ord_1009",
    customerId: "cust_009",
    type: "charge",
    amount: money("80.00", "USD"),
    idempotencyKey: null,
    createdAt: "2026-07-15T10:00:00Z",
  },
];

export interface CaseEventRecord {
  caseId: string;
  eventType: string;
  summary: string;
  createdAt: string;
  actor: string;
}

export const caseEvents: CaseEventRecord[] = [];

// --- Pristine snapshots for test isolation -------------------------------
// `customers` identityStatus and `paymentTransactions` are mutated in place
// by identity.ts/payments.ts. Individual modules' `_reset*MockState()`
// helpers only clear THEIR OWN derived state (idempotency cache, flaky-
// gateway counters); they must also restore this shared seed data back to
// its original values, or a refund/verification in one test leaks into the
// next. Captured once at module load, before anything can mutate it.
const pristineCustomerIdentityStatus = new Map(
  Object.values(customers).map((c) => [c.customerId, c.identityStatus])
);
const pristinePaymentTransactions: PaymentTransaction[] = paymentTransactions.map((t) => ({ ...t }));

export function _resetSeedDataMockState(): void {
  for (const customer of Object.values(customers)) {
    const original = pristineCustomerIdentityStatus.get(customer.customerId);
    if (original) customer.identityStatus = original;
  }
  paymentTransactions.length = 0;
  paymentTransactions.push(...pristinePaymentTransactions.map((t) => ({ ...t })));
  caseEvents.length = 0;
}
