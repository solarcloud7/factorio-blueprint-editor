import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { URL } from 'node:url'

const builderSource = readFileSync(
    new URL('../src/core/spriteDataBuilder.ts', import.meta.url),
    'utf8'
).replaceAll('\r\n', '\n')

function extractBalancedDeclaration(source, declaration, openCharacter, closeCharacter) {
    const start = source.indexOf(declaration)
    assert.ok(start >= 0, `${declaration} should exist`)
    const opening = source.indexOf(openCharacter, start)
    assert.ok(opening >= 0, `${declaration} should contain ${openCharacter}`)

    let depth = 0
    for (let index = opening; index < source.length; index++) {
        if (source[index] === openCharacter) depth++
        if (source[index] !== closeCharacter) continue
        depth--
        if (depth === 0) return source.slice(start, index + 1)
    }

    assert.fail(`${declaration} should have a balanced ${closeCharacter}`)
}

test('balanced extraction ignores neighboring names and nested braces', () => {
    const normalizedSource = [
        'function target() {',
        "    const decoy = 'function next() {}'",
        '    if (true) { return { nested: true } }',
        '}',
        'function next() {}',
    ]
        .join('\r\n')
        .replaceAll('\r\n', '\n')

    assert.equal(
        extractBalancedDeclaration(normalizedSource, 'function target', '{', '}'),
        normalizedSource.slice(0, normalizedSource.indexOf('\nfunction next'))
    )
})

function stripTypes(source) {
    return source
        .replaceAll('entityType: string', 'entityType')
        .replaceAll('piece: any', 'piece')
        .replaceAll('renderBand: GroundRailRenderBand', 'renderBand')
        .replaceAll('pictures: any', 'pictures')
        .replaceAll('e: RailPrototype', 'e')
        .replaceAll('data: IDrawData', 'data')
        .replaceAll('(): SpriteVariations[]', '()')
        .replaceAll('): readonly ExtendedSpriteData[]', ')')
        .replaceAll('): (data) => readonly ExtendedSpriteData[]', ')')
        .replaceAll('): (data) => readonly SpriteData[]', ')')
        .replaceAll(' as readonly ExtendedSpriteData[]', '')
        .replaceAll(' as SpriteVariations[]', '')
}

const helperSource = stripTypes(
    [
        extractBalancedDeclaration(builderSource, 'const GROUND_RAIL_ENTITY_TYPES', '(', ')'),
        extractBalancedDeclaration(builderSource, 'function railPieceLayers', '{', '}'),
        extractBalancedDeclaration(builderSource, 'function getRailBaseSprites', '{', '}'),
    ].join('\n')
)
const { railPieceLayers, getRailBaseSprites } = new Function(
    `${helperSource}; return { railPieceLayers, getRailBaseSprites }`
)()

const straightSource = stripTypes(
    extractBalancedDeclaration(builderSource, 'function draw_straight_rail', '{', '}')
)
const loadStraightRail = new Function(
    'util',
    'FD',
    'getEntitySize',
    'addToShift',
    'getRailBaseSprites',
    'railPieceLayers',
    `${straightSource}; return draw_straight_rail`
)

const groundTypes = [
    'legacy-straight-rail',
    'straight-rail',
    'half-diagonal-rail',
    'legacy-curved-rail',
    'curved-rail-a',
    'curved-rail-b',
]
const elevatedTypes = [
    'elevated-straight-rail',
    'elevated-half-diagonal-rail',
    'elevated-curved-rail-a',
    'elevated-curved-rail-b',
]
const expectedBands = [
    'ground-rail-underlay',
    'ground-rail-underlay',
    'ground-rail-structure',
    'ground-rail-structure',
    'ground-rail-foreground',
]

function pictures(layerCount = 1) {
    const group = name =>
        layerCount === 1
            ? Object.freeze({ filename: `${name}.png` })
            : Object.freeze({
                  layers: Object.freeze(
                      Array.from({ length: layerCount }, (_, index) =>
                          Object.freeze({ filename: `${name}-${index}.png` })
                      )
                  ),
              })
    return Object.freeze({
        stone_path_background: group('background'),
        stone_path: group('path'),
        ties: group('ties'),
        backplates: group('backplates'),
        metals: group('metals'),
    })
}

test('all six ground types receive the exact semantic bands without prototype mutation', () => {
    const prototypePictures = pictures()
    for (const type of groundTypes) {
        const parts = getRailBaseSprites(type, prototypePictures)
        assert.deepEqual(
            parts.map(part => part.renderBand),
            expectedBands,
            type
        )
        assert.ok(parts.every((part, index) => part !== Object.values(prototypePictures)[index]))
    }
    assert.ok(Object.values(prototypePictures).every(piece => !Object.hasOwn(piece, 'renderBand')))
})

test('every layer of every layered wrapper inherits its group band', () => {
    const parts = getRailBaseSprites('curved-rail-a', pictures(2))
    assert.deepEqual(
        parts.map(part => part.renderBand),
        expectedBands.flatMap(band => [band, band])
    )
})

test('elevated and non-ground types remain undefined', () => {
    for (const type of [...elevatedTypes, 'assembling-machine']) {
        const parts = getRailBaseSprites(type, pictures())
        assert.ok(
            parts.every(part => part.renderBand === undefined),
            type
        )
    }
})

test('cardinal straight gate extras are foreground', () => {
    const util = {
        getDirName8Way: () => 'north',
        sumprod: () => ({ x: 0, y: 0 }),
        rotatePointBasedOnDir: point =>
            Array.isArray(point) ? { x: point[0], y: point[1] } : point,
        duplicate: value => ({ ...value }),
    }
    const FD = {
        entities: {
            gate: {
                horizontal_rail_base: { filename: 'gate-horizontal.png' },
                vertical_rail_base: { filename: 'gate-vertical.png' },
            },
        },
    }
    const draw = loadStraightRail(
        util,
        FD,
        () => ({ x: 2, y: 2 }),
        (shift, piece) => ({ ...piece, shift }),
        getRailBaseSprites,
        railPieceLayers
    )({ type: 'straight-rail', pictures: { north: pictures() } })
    const parts = draw({
        dir: 0,
        position: { x: 0, y: 0 },
        positionGrid: {
            getEntitiesInArea: () => [{ type: 'gate', position: { x: 0, y: 0 } }],
        },
    })
    assert.equal(parts.length, 6)
    assert.equal(parts.at(-1).filename, 'gate-horizontal.png')
    assert.equal(parts.at(-1).renderBand, 'ground-rail-foreground')
})
