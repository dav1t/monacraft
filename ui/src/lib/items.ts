// Item "icons": a colored square with a two-letter label, colored by material.

const ITEM_COLORS: [RegExp, string][] = [
  [/diamond/, '#3ad6c9'], [/emerald/, '#2fbf55'], [/netherite/, '#4a3f45'], [/gold/, '#e8c13a'],
  [/iron/, '#d8d8d8'], [/copper/, '#c8693f'], [/coal|charcoal/, '#2b2b2b'], [/redstone/, '#c41a1a'],
  [/lapis/, '#2a4fbf'],
  [/oak|birch|spruce|jungle|acacia|dark_oak|mangrove|cherry|planks|stick|log|wood|crafting_table|chest/, '#9c7442'],
  [/cobble|stone|andesite|diorite|granite|deepslate|furnace/, '#8a8a8a'], [/dirt|mud|podzol/, '#7a5233'],
  [/grass|leaves|sapling|vine|kelp|fern/, '#4f9a32'], [/sand/, '#dbcf8c'], [/gravel|flint/, '#7d7570'],
  [/beef|porkchop|mutton|chicken|rabbit|cod|salmon/, '#d77a6a'], [/bread|wheat|hay/, '#d2a64c'],
  [/apple|melon|beetroot/, '#d1342c'], [/carrot|pumpkin/, '#e6862a'], [/potato|baked/, '#c9a35a'],
  [/water|ice/, '#3f76e4'], [/lava|fire|blaze/, '#ff7b1a'], [/string|wool|web|bone/, '#e9e9e9'],
  [/torch/, '#ffcf4a'], [/rotten|zombie/, '#6e8c3a'], [/obsidian|crying/, '#2b1f3d'], [/glass/, '#bde3ea'],
]

export function itemColor(name: string): string {
  return ITEM_COLORS.find(([pattern]) => pattern.test(name))?.[1] ?? '#9b6ac9'
}

/** `iron_pickaxe` → `IP`, `coal_ore` → `CO`, `dirt` → `DI`. */
export function abbreviate(name: string): string {
  const words = name.split('_')
  const parts = words.length > 1 ? words.filter((w) => !['block', 'ore', 'raw'].includes(w)) : words
  const first = parts[0] ?? name
  const last = parts.at(-1) ?? name
  return (parts.length > 1 ? first[0]! + last[0]! : name.slice(0, 2)).toUpperCase()
}
