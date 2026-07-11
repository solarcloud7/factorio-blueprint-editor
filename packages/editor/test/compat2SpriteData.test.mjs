import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// Factorio 2.x draw-side compatibility fixes. Each draw_* builder moved to a new art location in
// 2.x data.json; these tests eval the real function bodies (types stripped) against synthetic 2.x-
// shaped and legacy-shaped inputs, mirroring pumpSpriteData.test.mjs. No atlas or render needed.

const builderSource = readFileSync(
    new URL('../src/core/spriteDataBuilder.ts', import.meta.url),
    'utf8'
)

// Strip the TypeScript that appears inside these three function bodies so the source is valid JS
// for `new Function`: the `: IDrawData` param annotation and the multi-line `as | '...' | '...'`
// string-literal-union assertions (present in the pumpjack + electric-mining-drill branches).
function stripTypes(src) {
    return src
        .replaceAll(': IDrawData', '')
        .replace(/\bas(?:\s*\|\s*'[\w-]+')+/g, '')
}

function extractBody(startMarker, endMarker) {
    const start = builderSource.indexOf(startMarker)
    const end = builderSource.indexOf(endMarker, start)
    assert.ok(start >= 0 && end > start, `${startMarker} should exist before ${endMarker}`)
    const fnSource = builderSource.slice(start, end)
    return stripTypes(fnSource.slice(fnSource.indexOf('{') + 1, fnSource.lastIndexOf('}')))
}

const util = {
    getDirName: dir => ['north', 'east', 'south', 'west'][[0, 4, 8, 12].indexOf(dir)],
}

// --- FIX 1: draw_generator (steam-engine, steam-turbine) ----------------------------------
function loadDrawGenerator() {
    return new Function('e', extractBody('function draw_generator', '\nfunction draw_heat_interface'))
}

test('draw_generator reads pictures.{north,east}.animation.layers in 2.x', () => {
    const draw = loadDrawGenerator()({
        pictures: {
            north: { animation: { layers: [{ filename: 'steam-engine-V.png' }] } },
            east: { animation: { layers: [{ filename: 'steam-engine-H.png' }] } },
        },
    })
    // dir % 8 === 0 -> vertical orientation -> north art (V); else horizontal -> east art (H)
    assert.equal(draw({ dir: 0 })[0].filename, 'steam-engine-V.png')
    assert.equal(draw({ dir: 8 })[0].filename, 'steam-engine-V.png')
    assert.equal(draw({ dir: 4 })[0].filename, 'steam-engine-H.png')
    assert.equal(draw({ dir: 12 })[0].filename, 'steam-engine-H.png')
})

test('draw_generator falls back to legacy vertical/horizontal_animation', () => {
    const draw = loadDrawGenerator()({
        vertical_animation: { layers: [{ filename: 'old-V.png' }] },
        horizontal_animation: { layers: [{ filename: 'old-H.png' }] },
    })
    assert.equal(draw({ dir: 0 })[0].filename, 'old-V.png')
    assert.equal(draw({ dir: 4 })[0].filename, 'old-H.png')
})

// --- FIX 2: draw_mining_drill pumpjack branch ---------------------------------------------
function loadDrawMiningDrill() {
    // params: util, duplicateAndSetPropertyUsing (legacy path only), e
    return new Function(
        'util',
        'duplicateAndSetPropertyUsing',
        'e',
        extractBody('function draw_mining_drill', '\nfunction draw_offshore_pump')
    )
}

test('draw_mining_drill pumpjack composes working_visualisations base + animation head (2.x)', () => {
    const wv = {
        always_draw: true,
        north_animation: { layers: [{ filename: 'pumpjack-base.png' }] },
        east_animation: { layers: [{ filename: 'pumpjack-base.png' }] },
        south_animation: { layers: [{ filename: 'pumpjack-base.png' }] },
        west_animation: { layers: [{ filename: 'pumpjack-base.png' }] },
    }
    const draw = loadDrawMiningDrill()(util, x => x, {
        name: 'pumpjack',
        graphics_set: {
            animation: { north: { layers: [{ filename: 'pumpjack-horsehead.png' }] } },
            working_visualisations: [wv],
        },
    })
    for (const dir of [0, 4, 8, 12]) {
        const parts = draw({ dir })
        assert.equal(parts.length, 2, `pumpjack d${dir} = base + horsehead`)
        assert.equal(parts[0].filename, 'pumpjack-base.png', `pumpjack d${dir} base first`)
        // animation has only north; other directions fall back to it for the horsehead
        assert.equal(parts[1].filename, 'pumpjack-horsehead.png', `pumpjack d${dir} head`)
        assert.ok(parts.every(p => p.filename), 'no filename-less (silently dropped) parts')
    }
})

test('draw_mining_drill pumpjack falls back to base_picture.sheets when no working_visualisations', () => {
    const draw = loadDrawMiningDrill()(util, x => x, {
        name: 'pumpjack',
        base_picture: { sheets: [{ filename: 'old-base.png' }] },
        graphics_set: { animation: { north: { layers: [{ filename: 'horsehead.png' }] } } },
    })
    const parts = draw({ dir: 0 })
    assert.equal(parts[0].filename, 'old-base.png')
    assert.equal(parts[1].filename, 'horsehead.png')
})

// --- FIX 3: draw_logistic_container (the five logistic chests) -----------------------------
function loadDrawLogistic() {
    return new Function('e', extractBody('function draw_logistic_container', '\nfunction draw_mining_drill'))
}

test('draw_logistic_container reads robot_door.animation.layers in 2.x', () => {
    const draw = loadDrawLogistic()({
        robot_door: {
            animation: {
                layers: [
                    { filename: 'requester-chest.png', frame_count: 7 },
                    { filename: 'logistic-chest-shadow.png', draw_as_shadow: true },
                ],
            },
        },
    })
    const parts = draw()
    assert.equal(parts[0].filename, 'requester-chest.png')
    assert.equal(parts[1].draw_as_shadow, true)
})

test('draw_logistic_container falls back to legacy top-level animation.layers', () => {
    const draw = loadDrawLogistic()({ animation: { layers: [{ filename: 'old-chest.png' }] } })
    assert.equal(draw()[0].filename, 'old-chest.png')
})
