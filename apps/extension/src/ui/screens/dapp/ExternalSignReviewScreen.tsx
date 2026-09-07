import { useState } from 'react'

import type { ExternalSignLocalReview, PrepareSignResponse } from '@latch/types'

function hostnameFromOrigin(origin: string): string {
  try {
    return new URL(origin).hostname
  } catch {
    return origin
  }
}

function truncateAddress(address: string, left = 6, right = 4): string {
  if (address.length <= left + right + 3) return address
  return `${address.slice(0, left)}...${address.slice(-right)}`
}

const STALE_LOCAL_REVIEW: ExternalSignLocalReview = {
  operations: [],
  invokeContractIds: [],
  confirmBlocked: true,
  confirmBlockedReason:
    'This sign request is missing local review data. Reject and try again from the dApp.',
  code: 'unparseable_xdr',
}

export function ExternalSignReviewScreen({
  origin,
  prepared,
  localReview: localReviewProp,
  busy,
  progressLabel,
  error,
  onConfirm,
  onReject,
}: {
  origin: string
  prepared: PrepareSignResponse
  localReview?: ExternalSignLocalReview | null
  busy?: boolean
  progressLabel?: string | null
  error?: string | null
  onConfirm: () => void
  onReject: () => void
}) {
  const [expandedOp, setExpandedOp] = useState<number | null>(null)
  const hostname = hostnameFromOrigin(origin)
  const localReview = localReviewProp ?? STALE_LOCAL_REVIEW
  const operations = localReview.operations
  const feeLine = [
    prepared.feeLabel ?? null,
    prepared.estimatedFeeXlm ? `${prepared.estimatedFeeXlm} XLM` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const confirmBlocked = localReview.confirmBlocked
  const displayError = error ?? (confirmBlocked && !busy ? localReview.confirmBlockedReason : null)

  return (
    <div className="relative flex min-h-0 flex-1 flex-col animate-screenIn">
      <div className="text-center">
        <h2 className="text-2xl font-extrabold tracking-tight">Review transaction</h2>
        <p className="mt-2 text-sm text-muted">{hostname} requests your signature</p>
      </div>

      {prepared.warnings && prepared.warnings.length > 0 ? (
        <div className="mt-4 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">
          {prepared.warnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      ) : null}

      <div className="mt-4 space-y-3 overflow-y-auto flex-1 min-h-0">
        <div className="rounded-2xl border border-border bg-surface/60 p-4 shadow-soft">
          <div className="text-xs font-bold text-muted">Network</div>
          <div className="mt-1 text-sm font-bold capitalize">{prepared.network}</div>
          <div className="mt-3 text-xs font-bold text-muted">Smart account</div>
          <div className="mt-1 font-mono text-sm font-bold">
            {truncateAddress(prepared.smartAccountAddress)}
          </div>
          {prepared.validUntilLedger ? (
            <>
              <div className="mt-3 text-xs font-bold text-muted">Valid until ledger</div>
              <div className="mt-1 text-sm font-bold">{prepared.validUntilLedger}</div>
            </>
          ) : null}
          {feeLine ? (
            <>
              <div className="mt-3 text-xs font-bold text-muted">Estimated fee</div>
              <div className="mt-1 text-sm font-bold">{feeLine}</div>
            </>
          ) : null}
        </div>

        <div className="rounded-2xl border border-border bg-surface/60 p-4 shadow-soft">
          <div className="text-xs font-bold text-muted">Operations</div>
          {operations.length === 0 ? (
            <p className="mt-2 text-sm text-muted">
              No operation details were provided for this request.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {operations.map((op, idx) => (
                <li key={`${op.type}-${idx}`} className="rounded-xl border border-border/60 p-3">
                  <button
                    type="button"
                    className="w-full text-left"
                    onClick={() => setExpandedOp(expandedOp === idx ? null : idx)}
                  >
                    <div className="text-sm font-bold">{op.summary}</div>
                    {op.details && expandedOp === idx ? (
                      <dl className="mt-2 space-y-1 text-xs text-muted">
                        {Object.entries(op.details).map(([k, v]) => (
                          <div key={k} className="flex justify-between gap-2">
                            <dt className="font-semibold">{k}</dt>
                            <dd className="break-all text-right font-mono">{v}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {displayError ? (
        <p className="mt-3 text-center text-sm text-red-300">{displayError}</p>
      ) : null}

      <div className="mt-4 space-y-3 shrink-0">
        <button
          type="button"
          disabled={busy || confirmBlocked}
          onClick={onConfirm}
          className="h-12 w-full rounded-full bg-primary text-base font-extrabold text-black shadow-soft disabled:opacity-60"
        >
          {busy ? (progressLabel ?? 'Signing…') : 'Confirm'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onReject}
          className="h-12 w-full rounded-full border border-border bg-surface text-base font-bold text-fg shadow-soft disabled:opacity-60"
        >
          Reject
        </button>
      </div>
    </div>
  )
}
