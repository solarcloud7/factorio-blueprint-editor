import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const builderSource = readFileSync(
    new URL('../src/core/spriteDataBuilder.ts', import.meta.url),
    'utf8'
)
const entitySpriteSource = readFileSync(
    new URL('../src/containers/EntitySprite.ts', import.meta.url),
    'utf8'
)

function loadDrawPump() {
    const start = builderSource.indexOf('function draw_pump')
    const end = builderSource.indexOf('\nfunction draw_radar', start)
    assert.ok(start >= 0 && end > start, 'draw_pump should exist')
    const fnSource = builderSource.slice(start, end)
    const body = fnSource.slice(fnSource.indexOf('{') + 1, fnSource.lastIndexOf('}'))
    return new Function('util', 'e', `${body.replaceAll(': IDrawData', '')}\n`) // eslint-disable-line no-new-func
}

function loadSilentDropCounter() {
    const start = entitySpriteSource.indexOf('export function countSilentSpriteDrops')
    const end = entitySpriteSource.indexOf('\n\nexport class EntitySprite', start)
    assert.ok(start >= 0 && end > start, 'countSilentSpriteDrops should be exported')
    const fnSource = entitySpriteSource
        .slice(start, end)
        .replace(/export function countSilentSpriteDrops\([^)]*\): void \{/, '')
        .replace(/\}\s*$/, '')
        .replaceAll(' as any', '')
    return new Function('spriteData', fnSource) // eslint-disable-line no-new-func
}

test('draw_pump returns body and shadow layers for every cardinal direction', () => {
    const names = ['north', 'east', 'south', 'west']
    const util = { getDirName: dir => names.get?.(dir) ?? names[[0, 4, 8, 12].indexOf(dir)] }
    const animations = Object.fromEntries(
        names.map(name => [
            name,
            {
                layers: [
                    { filename: `${name}-body.png` },
                    { filename: `${name}-shadow.png`, draw_as_shadow: true },
                ],
            },
        ])
    )
    const drawPump = loadDrawPump()(util, { animations })

    for (const dir of [0, 4, 8, 12]) {
        const parts = drawPump({ dir })
        assert.equal(parts.length, 2, `direction ${dir} must include body plus shadow`)
        assert.match(parts[0].filename, /-body\.png$/)
        assert.equal(parts[1].draw_as_shadow, true)
    }
})

test('filename-less parts increment degraded once while shadows do not', () => {
    const countSilentSpriteDrops = loadSilentDropCounter()
    globalThis.__factographDegraded = 0
    countSilentSpriteDrops([{ layers: [{ filename: 'nested.png' }] }, undefined])
    assert.equal(
        globalThis.__factographDegraded,
        1,
        'multiple silent drops still count once per entity'
    )

    countSilentSpriteDrops([{ filename: 'shadow.png', draw_as_shadow: true }])
    assert.equal(globalThis.__factographDegraded, 1, 'legitimate shadow skips must not degrade')
    delete globalThis.__factographDegraded
})
