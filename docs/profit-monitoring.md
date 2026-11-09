# RIG owner finances and price protection

Only the signed production user pinned by `RIG_PRODUCTION_OWNER_USER_ID` can use `/api/owner/finance`. Customer accounts receive no financial records or policy data, even if they forge browser role or identity fields. Financial endpoints use independent signed routing and remain available when video generation is suspended. Responses are private and never cached; the browser clears financial data on logout or an account change.

## Release settings

Approved base rates are Standard EUR0.30/second, Pro EUR0.40/second and Edit EUR0.35/second, rounded up to whole billed seconds. Minimums are EUR1.00 for Standard/Edit and EUR1.25 for Pro. A new quote also covers the minimum estimated contribution margin; any required adjustment is shown before customer confirmation. Five-second prices at the current provider rates are EUR1.50, EUR2.00 and EUR1.75. Edit remains limited to 15 seconds and motion to 30 seconds. The retail cap is EUR12/video; the provider cap remains US$6/video. Credit packages remain EUR5/10/25 with equal-value EUR credit.

Apply `production-migrations/0003_profit_monitoring.sql` to the production D1 after a fresh backup. Its four new tables do not change customer orders, balances, provider credentials or the separate TEST database. Deploy these approved existing Worker variables together with the reviewed code:

```
RIG_PRODUCTION_PRICE_STANDARD=30
RIG_PRODUCTION_PRICE_PRO=40
RIG_PRODUCTION_PRICE_EDIT=35
RIG_PRODUCTION_PRICE_VERSION=rig-margin-2026-11-09-v1
RIG_PRODUCTION_VIDEO_MAX_CENTS=1200
```

The initial planning policy uses EUR1/US$1, a 21% non-deductible provider-VAT reserve, a 10% payment-cost reserve, a 10% failure reserve on provider cost, EUR0.05 preparation per job and 30% minimum contribution margin. These are conservative budgeting assumptions, not verified tax rates, card conversions or invoice charges. The owner can change them with version control and an audit history. A missing/invalid policy fails closed.

## Spending and quote safety

The initial shared daily Fal authorization cap is US$10, measured by UTC date. A single D1 transaction journals each authorized job and conditionally permits exactly one dispatch, including owner-funded jobs. Previous-day unknown/submitting liabilities remain counted; uncertain outcomes never automatically release provider budget or trigger another paid submission. The budget covers RIG authorizations, not unrelated Fal dashboard or Mac-app usage.

The final customer quote binds the exact retail amount, immutable media and internal policy/cost snapshot. Wholesale figures and the snapshot are never serialized into customer price/job responses. New quotes must meet the margin target; changed policy or missing historical snapshots require a fresh confirmation before a new dispatch. Already dispatched jobs remain pollable without repricing. Price increases do not silently change an existing confirmation.

## Reading the overview

- Cash receipts count paid orders backed by their unique credit-ledger entry, excluding open/expired checkouts.
- Earned video revenue counts completed paid-credit consumption. Promotional credit is conservatively allocated first and does not become sales revenue. Owner-funded use has zero sales.
- Current credit liability includes available credit plus unresolved reservations; negative customer accounts do not offset other customers' claims.
- Completed video revenue and estimated costs appear in the same Europe/Brussels reporting month. The report is operational, not a tax return.
- Costs and contribution from immutable snapshots are estimates. Missing historical snapshots remain unknown.
- Actual invoice costs can be recorded with idempotency keys and corrected through append-only replacements. Superseded entries are excluded; zero-value corrections void mistakes while preserving history.
- Fal top-ups are separate cash outlays, not a second charge for generated output. Generic customer refunds are separate cash outflows, not automatic operating expenses or earned-revenue adjustments. Recording a refund does not send money or alter customer credit.
- Recorded operating results reflect only entered costs. Full actual profit remains unknown because invoice completeness has not been certified. There is no automatic Fal billing, Mollie fee or Peppol integration in this release.

The owner should enter EUR invoice amounts including any actually owed, non-deductible VAT. Taxes on income, social contributions, result quality acceptance and formal prepaid-credit accounting remain separate from the operational contribution estimate.
