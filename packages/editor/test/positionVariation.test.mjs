import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../src/core/spriteDataBuilder.ts', import.meta.url), 'utf8')

function loadPositionVariation() {
    const match = source.match(
        /export function positionVariation\s*\(\s*pos:\s*IPoint\s*,\s*variations:\s*number\s*\):\s*number\s*\{(?<body>[\s\S]*?)\n\}/
    )

    assert.ok(match?.groups?.body, 'positionVariation helper should be exported')

    return new Function('pos', 'variations', `${match.groups.body}\n`) // eslint-disable-line no-new-func
}

test('positionVariation is deterministic, bounded, and varied across neighboring wall tiles', () => {
    const positionVariation = loadPositionVariation()
    const samples = Array.from({ length: 8 }, (_, x) => positionVariation({ x, y: 12 }, 4))

    assert.deepEqual(
        samples,
        Array.from({ length: 8 }, (_, x) => positionVariation({ x, y: 12 }, 4))
    )
    assert.ok(samples.every(value => Number.isInteger(value) && value >= 0 && value < 4))
    assert.ok(new Set(samples).size >= 2, 'neighboring wall tiles should not all use one variation')
    assert.equal(positionVariation({ x: 3, y: 4 }, 0), 0)
})

test('wall sprite selection uses positionVariation instead of random process state', () => {
    const drawWallSource = source.slice(
        source.indexOf('function draw_wall'),
        source.indexOf('\nexport { getSpriteData')
    )

    assert.match(drawWallSource, /positionVariation\(data\.position,\s*wall\.line_length\)/)
    assert.match(drawWallSource, /positionVariation\(data\.position,\s*pictures\.filling\.line_length\)/)
    assert.doesNotMatch(drawWallSource, /util\.getRandomInt/)
})
