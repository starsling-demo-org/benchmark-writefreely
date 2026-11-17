# P5c (cold-only P5) prepared trees, harness 0f9f850 (recorded after bench prepare, before dispatch)

Upstream pin: writefreely/writefreely@5d1bc057e86aafb6888bf301376b46ea5e0620e7 (upstream tree 7a694b0132173b0c2b1862fe769c305f09ee95a8; upstream tree excluding .github ef89d9cfac8b6a167c73eb58dfcde06c382d2906).
Fix arm: local patches lever A (cross-compile.patch, git blob 584ffb2d95fbadfb5b3babc8ea75504e80f80081) then lever B (ui-stage.patch, 56b4d6e13e590fb482ab20e679c05d3289aaf8ef). No inBaseline, no C, no D.
Prepared record: .bench-work/prepared/d6ebc01206d7 (harness 0f9f850, which asserts every tracked upstream path is staged; the check passed).

| variant | replay headSha | git tree of headSha | git tree excluding .github | .github tree | sourceTreeHash (harness SHA-256) |
|---|---|---|---|---|---|
| github-baseline | 1167713c4769aecd191176a7038eb3168ac19ccd | eb2e57431cc2ec9622991c978a5241757912f6e8 | ef89d9cfac8b6a167c73eb58dfcde06c382d2906 | c5acf7a9e059dd60f695a991d57d0b481158741d | 638997ef4d1a878725a54e3b26d7c58ffd06b262d7652386efe8858b00a98a66 |
| starsling-baseline | 2ea8cfb1c2f48ca7298a51297a7264b830b78e51 | d9e94af5a45bc5974cca1159beea1dde2cd250dc | ef89d9cfac8b6a167c73eb58dfcde06c382d2906 | 4c32a57285c9249963a886b9a5b3731b48d4f758 | 6fed52a20a91b633b69371ef8c7d2451c3d20718fd5d684cd7f2dd627ad99d63 |
| starsling-patched | 15747e6f8530ebd0325c03c11e12a397eaebc030 | c426254950a8417814c556d51a0311e4ef145494 | e5d36ffab4fc37727c4b93ba52ccaac3378d25bc | 4c32a57285c9249963a886b9a5b3731b48d4f758 | f109422de87eb482e4570e0ed4530d1b78bc93da3b7a77c13ba9fd036d3457b6 |

## Checks

- Both baseline arms: git tree excluding .github is ef89d9cfac8b6a167c73eb58dfcde06c382d2906, exactly the upstream pin's tree excluding .github (the two stylesheets static/css/lib/atom-one-light.min.css and mono-blue.min.css are present in all three arms; the earlier b860c0b harness had dropped them).
- Workflow diff GitHub arm vs StarSling arm (baseline and patched): one line only, .github/workflows/docker-publish.yml line 24, `runs-on: ubuntu-24.04-4core` becomes `runs-on: starsling-ubuntu-24.04`.
- starsling-patched tree excluding .github (e5d36ffab4fc37727c4b93ba52ccaac3378d25bc) is the pin tree with patches A and B applied.
- The harness hashes (sourceTreeHash) are unchanged from the b860c0b record; the replay head commits and trees changed because the two files are now staged.
