import React, { useState } from 'react'

import { friendlyError, sendToBackground } from '../../lib/backgroundClient'

export function DeveloperModeConfirmScreen({
  enabling,
  onBack,
  onApplied,
}: {
  enabling: boolean
  onBack: () => void
  onApplied: () => void | Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function apply() {
    setBusy(true)
    setError(null)
    try {
      const res = await sendToBackground<{ enabled: boolean }, { enabled: boolean }>({
        type: 'SET_DEVELOPER_MODE',
        payload: { enabled: enabling },
      })
      if (!res.ok) throw new Error(friendlyError(res.error))
      await onApplied()
      onBack()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <button
        type="button"
        onClick={onBack}
        className="self-start text-sm text-[#fcfcfc]/opacity-70"
        disabled={busy}
      >
        Back
      </button>
      <h2 className="text-lg font-semibold tracking-[-0.32px] text-[#fcfcfc]">
        {enabling ? 'Turn on developer mode?' : 'Turn off developer mode?'}
      </h2>
      <p className="text-sm leading-5 text-[#fcfcfc]/opacity-70">
        Testnet funds have no value. Wallets on the other deployment stay hidden until you switch
        back.
      </p>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      <button
        type="button"
        disabled={busy}
        onClick={() => void apply()}
        className="rounded-xl bg-[#ffad00] px-4 py-3 text-center text-base font-semibold text-[#1f1f1f] disabled:opacity-50"
      >
        {busy ? 'Switching…' : enabling ? 'Turn on testnet' : 'Turn off testnet'}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onBack}
        className="rounded-xl border border-[#2b2a29] px-4 py-3 text-center text-base text-[#fcfcfc]"
      >
        Cancel
      </button>
    </div>
  )
}
