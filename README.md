# F2L Coach

A local trainer for advanced F2L (CFOP first two layers). See [SPEC.md](SPEC.md) for the full build spec.

```sh
npm install
npm run dev     # open the printed localhost URL in Chrome or Edge
npm test        # unit tests (cube model, 41 case algs, scrambles)
```

**Practice** — the *Pairs* slider (1–4) sets how many slots are unsolved; scrambles stay short (~4–5 moves per pair) and the cross is always solved.
**Case drill** — pick case numbers from your sheet (`f2l-cases.html`); each drill is one front-right pair, with the case and algorithm revealed after you solve it.

Turn with the keyboard (csTimer-style keys, press `?`), or drag a sticker. Drag the background to orbit, `Esc` resets the view.
