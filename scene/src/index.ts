// BattleZone — entry point. One codebase, two roles: the headless multiplayer
// server (authoritative) and the in-world client.

import { isServer } from '@dcl/sdk/network'
import './shared/components'
import './shared/messages'
import { engine, SkyboxTime } from '@dcl/sdk/ecs'
export async function main() {
  SkyboxTime.create(engine.RootEntity, { fixedTime: 86400 })

  if (isServer()) {
    console.log('[Main] SERVER mode')
    try {
      const { setupServer } = await import('./server/server')
      await setupServer()
    } catch (err) {
      console.error('[Main] SERVER STARTUP FAILED:', err)
      throw err
    }
    return
  }

  console.log('[Main] CLIENT mode')
  const { setupClient } = await import('./client/setup')
  await setupClient()
}
