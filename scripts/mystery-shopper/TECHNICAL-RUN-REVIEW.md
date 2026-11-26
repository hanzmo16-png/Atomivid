This is a proposed operator rerender path, not a new paid script/customer-flow proof. Preparation does not authorize execution. No allocation receipt may be created until the owner explicitly approves the reallocation; elapsed time never supplies approval.

Default `review`, `apply-and-quote`, and `quote` operations retain their existing behavior. Only the separate `run-owner-approved` operation can send the two production POSTs, and it fails closed without both root-reviewed private proofs.

Required allocation receipt fields (JSON in the existing private receipts directory):

```json
{
  "scope": "OWNER_APPROVED_ONE_TECHNICAL_LONG_FORM_RUN",
  "approved": true,
  "requestId": "<reviewed new QA request>",
  "reviewSha256": "<review SHA256>",
  "ownerId": "<authenticated QA owner>",
  "ownerReplyRef": "<actual explicit owner reply reference>",
  "ownerReplySha256": "<SHA256 of actual owner reply already reviewed by root>",
  "approvedAt": "<actual approval UTC time>",
  "expiresAt": "<explicit expiry UTC time>",
  "maxNewUsd": 2,
  "totalCapUsd": 8.5,
  "reservedAvUsd": 3,
  "moduleCaps": { "youtube": 4, "audio-podcast": 1, "reels": 0.5, "video-podcast": 3 },
  "ledgerBaselineSha256": "<canonical snapshotSha of full strict historical ledger>"
}
```

Required deployment proof fields: scope `ROOT_VERIFIED_PRODUCTION_PAID_QA_GATES`, matching `requestId` and `reviewSha256`, target `https://atomivid.vercel.app`, `nativeDarkQc: true`, `privateProviderLogs: true`, exact `productionSha`, actual numeric `githubDeploymentId`, actual `environment` (`production` or `Production`), and `expiresAt`. Root must independently verify these gates in the deployed production source before issuing this proof. The runner checks that GitHub's latest production deployment still has that exact SHA/id and successful status before each production POST.

Both complete proof bodies require their own canonical `snapshotSha` accepted by root. Missing, expired, mismatched or malformed receipts deny execution. The full historical ledger snapshot must remain unchanged. Default commercial/module policy constants are unchanged; this owner receipt scopes a separate allocation to this single fenced job.

The separate `record-owner-allocation` operation is ROOT ONLY: `GITHUB_ACTOR` must equal the repository owner, and actual `owner_reply_ref` and `owner_reply_sha` inputs are mandatory. It derives the full private ledger baseline at runtime, refuses historical open exposure, and writes a one-hour create-only receipt. It has no raw-reply input, public ledger amounts, request mutations, reservation or generation. Do not dispatch this operation while the owner's answer is pending. No deployment-proof writer exists: root must verify the actual deployed native QC/private-log source before supplying that proof.

After the owner reply, root review of this code, review of both actual private receipts, and deployment verification, the one manual command would be:

```bash
gh workflow run mystery-shopper.yml --repo "$QA_REPOSITORY" --ref codex/endgame-fresh-longform-20261126 \
  -f operation=run-owner-approved -f new_request_id="$QA_REQUEST_ID" \
  -f review_receipt="$QA_REVIEW_RECEIPT" -f accepted_review_sha="$QA_REVIEW_SHA" \
  -f allocation_receipt="$QA_ALLOCATION_RECEIPT" -f allocation_receipt_sha="$QA_ALLOCATION_SHA" \
  -f deployment_receipt="$QA_DEPLOYMENT_RECEIPT" -f deployment_receipt_sha="$QA_DEPLOYMENT_SHA"
```

The reservation is the entire newly verified UI quote, at most USD 2, under a new create-only key. No paid script job, fake zero script settlement, old funding reuse, historical alteration, or automatic retry is performed. The render POST carries `acceptedCeilingUsd` and is allowed only after the confirmed server plan and current worker budget still fit the full reservation with zero paid AI visuals. The browser denies every other mutation and direct paid-provider host.

Any crash or ambiguous outcome leaves its fence and reservation in place. This path never settles even a completed render: a separate root review must establish closed-worker journal costs and native output QC before reconciliation or delivery claims.
