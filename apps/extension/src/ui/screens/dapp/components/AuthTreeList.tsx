import type { AuthTreeNode, ExternalSignAuthTreeEntry } from '@latch/types'

import { truncateMiddle } from '../../../lib/sendAddress'

function nodeLabel(node: AuthTreeNode): string {
  if (node.kind === 'create_contract') return 'Deploys a contract'
  if (node.kind === 'contract_fn' && node.contractId) {
    return `Call ${truncateMiddle(node.contractId)}::${node.functionName ?? ''}`
  }
  return 'Call that could not be read'
}

/** Every call each signed auth entry authorizes, nested calls indented under their parent. */
export function AuthTreeList({ entries }: { entries: ExternalSignAuthTreeEntry[] }) {
  return (
    <div className="rounded-2xl border border-border bg-surface/60 p-4 shadow-soft">
      <div className="text-xs font-bold text-muted">Authorizations</div>
      <div className="mt-2 space-y-3">
        {entries.map((entry) => (
          <ul key={entry.entryIndex} className="space-y-1">
            {entry.nodes.map((node, idx) => (
              <li
                key={idx}
                style={{ paddingLeft: node.depth * 12 }}
                className={node.selfCall ? 'text-sm font-bold text-red-300' : 'text-sm font-bold'}
              >
                <span className="font-mono">{nodeLabel(node)}</span>
                {node.selfCall ? (
                  <span className="ml-2 text-xs">
                    {node.kind === 'contract_fn' ? 'Changes your wallet' : 'Not allowed'}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ))}
      </div>
    </div>
  )
}
