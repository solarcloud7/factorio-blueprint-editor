import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// Factorio 2.x Space Age draw-side compatibility fixes (triage #3). Each draw_* builder either
// switched on a missing name (returning undefined -> placeholder) or read a field whose 2.x shape
// moved. These tests eval the real function bodies (types stripped) against synthetic inputs shaped
// like the real 2.x data.json (filenames are the actual art discovered from
// packages/exporter/data/output/data.json), mirroring compat2SpriteData.test.mjs. No atlas/render.

const builderSource = readFileSync(
    new URL('../src/core/spriteDataBuilder.ts', import.meta.url),
    'utf8'
)

// Strip the TypeScript that appears inside these function bodies so the source is valid JS for
// `new Function`: the `: IDrawData` param annotation, the multi-line `as | '...' | '...'`
// string-literal-union assertions, `as any` casts, and `: any` param annotations.
function stripTypes(src) {
    return src
        .replaceAll(': IDrawData', '')
        .replace(/\bas(?:\s*\|\s*'[\w-]+')+/g, '')
        .replace(/ as any\b/g, '')
        .replace(/: any\b/g, '')
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

// --- FIX 1: draw_mining_drill default (big-mining-drill + modded drills) -------------------
// draw_mining_drill switched on e.name with no default, so any mining-drill that is not
// burner/pumpjack/electric returned undefined and rendered a placeholder box. The fix makes the
// electric-mining-drill composition (per-direction animation + always_draw working_visualisations)
// the default for any drill exposing graphics_set.animation.
function loadDrawMiningDrill() {
    return new Function(
        'util',
        'duplicateAndSetPropertyUsing',
        'e',
        extractBody('function draw_mining_drill', '\nfunction draw_offshore_pump')
    )
}

test('draw_mining_drill default composes animation + working_visualisations for big-mining-drill', () => {
    const draw = loadDrawMiningDrill()(util, x => x, {
        name: 'big-mining-drill',
        graphics_set: {
            animation: {
                north: { layers: [{ filename: 'big-mining-drill-N-still.png' }] },
                east: { layers: [{ filename: 'big-mining-drill-E-still.png' }] },
                south: { layers: [{ filename: 'big-mining-drill-S-still.png' }] },
                west: { layers: [{ filename: 'big-mining-drill-W-still.png' }] },
            },
            working_visualisations: [
                { always_draw: true, animation: { layers: [{ filename: 'ignored-nondirectional.png' }] } },
                {
                    always_draw: true,
                    north_animation: { filename: 'big-mining-drill-N-wv.png' },
                    east_animation: { filename: 'big-mining-drill-E-wv.png' },
                    south_animation: { filename: 'big-mining-drill-S-wv.png' },
                    west_animation: { filename: 'big-mining-drill-W-wv.png' },
                },
                { always_draw: false, north_animation: { filename: 'not-always-draw.png' } },
                { always_draw: true }, // no directional animation -> filtered out, must not throw
            ],
        },
    })
    for (const [dir, tag] of [[0, 'N'], [4, 'E'], [8, 'S'], [12, 'W']]) {
        const parts = draw({ dir })
        assert.equal(parts[0].filename, `big-mining-drill-${tag}-still.png`, `d${dir} base still first`)
        assert.equal(parts[1].filename, `big-mining-drill-${tag}-wv.png`, `d${dir} directional wv`)
        assert.equal(parts.length, 2, `d${dir}: still + directional wv only`)
        assert.ok(parts.every(p => p.filename), `d${dir} no filename-less (silently dropped) parts`)
    }
})

test('draw_mining_drill default renders without working_visualisations (base animation only)', () => {
    const draw = loadDrawMiningDrill()(util, x => x, {
        name: 'some-modded-drill',
        graphics_set: { animation: { north: { layers: [{ filename: 'modded-drill.png' }] } } },
    })
    const parts = draw({ dir: 0 })
    assert.equal(parts.length, 1)
    assert.equal(parts[0].filename, 'modded-drill.png')
})

test('draw_mining_drill throws loudly for an unknown graphics shape', () => {
    // The throw is in the outer builder (no animation to compose), so it fires when the entity is
    // registered, not lazily at draw time — a visible crash rather than a silent placeholder.
    const build = loadDrawMiningDrill()
    assert.throws(
        () => build(util, x => x, { name: 'mystery-drill', graphics_set: {} }),
        /unsupported graphics shape/
    )
})

test('draw_mining_drill keeps the pumpjack branch (triage #2 fix)', () => {
    const draw = loadDrawMiningDrill()(util, x => x, {
        name: 'pumpjack',
        graphics_set: {
            animation: { north: { layers: [{ filename: 'pumpjack-horsehead.png' }] } },
            working_visualisations: [
                { always_draw: true, north_animation: { layers: [{ filename: 'pumpjack-base.png' }] } },
            ],
        },
    })
    const parts = draw({ dir: 0 })
    assert.equal(parts[0].filename, 'pumpjack-base.png')
    assert.equal(parts[1].filename, 'pumpjack-horsehead.png')
})

// --- FIX 2: draw_lightning_attractor (fulgoran-ruin-attractor) -----------------------------
// lightning-rod / -collector expose chargable_graphics.picture; the fulgoran-ruin-attractor has no
// picture, only charge_animation / discharge_animation. Fall back picture ?? charge ?? discharge.
function loadDrawLightningAttractor() {
    return new Function(
        'e',
        extractBody('function draw_lightning_attractor', '\nfunction draw_linked_belt')
    )
}

test('draw_lightning_attractor reads chargable_graphics.picture for lightning-rod (unchanged)', () => {
    const draw = loadDrawLightningAttractor()({
        chargable_graphics: { picture: { layers: [{ filename: 'lightning-rod.png' }] } },
    })
    assert.equal(draw()[0].filename, 'lightning-rod.png')
})

test('draw_lightning_attractor falls back to charge_animation for fulgoran-ruin-attractor', () => {
    // No picture; charge_animation is the mechanical (frame-0) default (HITL: charge vs discharge).
    const draw = loadDrawLightningAttractor()({
        chargable_graphics: {
            charge_animation: { layers: [{ filename: 'lightning-rod-charge.png' }] },
            discharge_animation: { layers: [{ filename: 'lightning-rod-discharge.png' }] },
        },
    })
    assert.equal(draw()[0].filename, 'lightning-rod-charge.png')
})

test('draw_lightning_attractor unwraps a layer-less animation with the `.layers ?? [a]` idiom', () => {
    const draw = loadDrawLightningAttractor()({
        chargable_graphics: { charge_animation: { filename: 'single-charge.png' } },
    })
    const parts = draw()
    assert.equal(parts.length, 1)
    assert.equal(parts[0].filename, 'single-charge.png')
})

// --- FIX 3: draw_cargo_bay (landing-pad-unloading-bay) -------------------------------------
// cargo-bay / hub graphics_set.picture is an array of layered sprites; the unloading-bay's is a
// DIRECTIONAL object {north,east,south,west}, each an array. Branch on Array.isArray, pick direction.
function loadDrawCargoBay() {
    return new Function('util', 'e', extractBody('function draw_cargo_bay', '\nfunction draw_cargo_landing_pad'))
}

test('draw_cargo_bay reads the array picture for cargo-bay / hub (unchanged)', () => {
    const draw = loadDrawCargoBay()(util, {
        graphics_set: {
            picture: [
                { layers: [{ filename: 'shared-cargo-bay-0.png' }] },
                { layers: [{ filename: 'shared-cargo-bay-1.png' }] },
            ],
        },
    })
    const parts = draw({ dir: 0 })
    assert.equal(parts.length, 2)
    assert.equal(parts[0].filename, 'shared-cargo-bay-0.png')
    assert.equal(parts[1].filename, 'shared-cargo-bay-1.png')
})

test('draw_cargo_bay picks the direction for the directional unloading-bay picture', () => {
    const draw = loadDrawCargoBay()(util, {
        graphics_set: {
            picture: {
                north: [{ layers: [{ filename: 'extractor-n-1.png' }, { filename: 'extractor-n-4.png' }] }],
                east: [{ layers: [{ filename: 'extractor-e-3.png' }] }],
                south: [{ layers: [{ filename: 'extractor-s-1.png' }] }],
                west: [{ layers: [{ filename: 'extractor-w-1.png' }] }],
            },
        },
    })
    const north = draw({ dir: 0 })
    assert.equal(north.length, 2, 'north picture flattens both layers')
    assert.equal(north[0].filename, 'extractor-n-1.png')
    assert.equal(north[1].filename, 'extractor-n-4.png')
    assert.equal(draw({ dir: 4 })[0].filename, 'extractor-e-3.png', 'east picks east art')
    assert.ok(north.every(p => p.filename), 'no filename-less (silently dropped) parts')
})
