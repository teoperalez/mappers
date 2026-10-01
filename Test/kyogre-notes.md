# Kyogre backport mappers

The two pairs are `GB/Kyogre_red_blue.xml` / `.js` and
`GB/Kyogre_yellow.xml` / `.js`. Red/Blue share one mapper; Yellow uses its own
WRAM layout and move IDs. Internal species `$BF` is Kyogre, dex #152.

The game identity is the canonical `Red and Blue` or `Yellow`, with
`meta.backport_id=kyogre` and a distinct mapper display name and UUID.

| Move | Red/Blue ID | Yellow ID |
|---|---|---|
| Scary Face | AD | AC |
| Water Pulse | AE | AD |
| Calm Mind | AF | AE |
| Sheer Cold | B0 | AF |
| Water Spout | B1 | B0 |

`battle.other.rain_dance_turns` exposes the numeric duration; 7 is permanent
Drizzle rain. `battle.other.rain_duration` labels it `Permanent (Drizzle)`.
The pending weather tick bit is masked; Yellow's low confusion nibble is
excluded from weather. All six party slots use the final ROM addresses.

These mappers match the October 1, 2026 ROM builds:

| ROM | SHA-256 |
|---|---|
| Red GBC UMB | `95dfae400607c43aa4eda4d3ae57c0a6e563844e8c53f6a607dbbe1153229168` |
| Blue GBC UMB | `8bb3be3048737422c10f6c56f5e4898c8f1215d3ed2c0744e6906af7c4553575` |
| Yellow | `77915eec607b3ba69714605fa86e1132678f2286b3af606d854d340de97c216a` |

Reproducible sources and the symbol-derived mapper builder are in the private
[Red/Blue archive](https://github.com/teoperalez/gen1-kyogre-red-gbc-umb-backport)
and [Yellow archive](https://github.com/teoperalez/gen1-kyogre-yellow-backport).

The Red/Blue processor inherits the existing Lugia/Rayquaza reset protection.
It skips CGB palette banks, rejects torn reset samples, restores the frozen
trainer ID and retains cumulative timer/TM/reset counters. The Yellow
processor retains its existing battle/weather logic.

Run `node --test Test/kyogre-mapper.test.cjs`. The helper expands the actual
mapper XML, decodes bytes using its definitions, invokes the actual mapper
JavaScript and simulates ordered GameHook notifications. It was extracted
from the existing Rayquaza reset test. Eight tests cover species/dex/type/
active HP, every new move in all four move slots, all 256 weather byte values
in each layout, frozen-ID recovery, bank/reset noise and live mapper reload.

These checks are isolated fixtures. They do not open or contact GameHook,
an emulator, an overlay app, OBS or production databases, and do not send
keyboard/mouse input. A live mapper session has not been exercised here.
