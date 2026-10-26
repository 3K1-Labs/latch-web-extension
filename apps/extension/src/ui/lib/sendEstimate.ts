import { isBuildSendMissingSetupError } from './sendTx'
import { SEND_SETUP_FAILED_CODE, type SendFeeEstimate } from '../types/send'

type Estimate = NonNullable<SendFeeEstimate>

/**
 * Build once; if the build reports missing send rules, run the one-time setup and build again so
 * the summary shows the real fee before Confirm enables. The rebuild happens only when setup
 * actually changed something: `already_configured` means the failure was not about setup, so the
 * original error is returned as is (no second build, no loop).
 */
export async function estimateSendWithSetup(args: {
  build: () => Promise<Estimate>
  /** Called just before the one-time setup starts, so the screen can say what is happening. */
  onSettingUp?: () => void
  runSetup: () => Promise<
    { ok: true; result: 'configured' | 'already_configured' } | { ok: false; message: string }
  >
}): Promise<Estimate> {
  const first = await args.build()
  if (first.ok || !isBuildSendMissingSetupError(first.error)) return first
  args.onSettingUp?.()
  const setup = await args.runSetup()
  if (!setup.ok) {
    return { ok: false, error: { message: setup.message, code: SEND_SETUP_FAILED_CODE } }
  }
  return setup.result === 'configured' ? args.build() : first
}
