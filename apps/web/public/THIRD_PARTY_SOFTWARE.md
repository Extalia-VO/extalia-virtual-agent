# Third-party software

## Advanced Graph View

Source: https://github.com/n23eos/advanced_graph_view

Pinned revision: 17e3eb1fd0e64d4d13d9a130c4bd77b2f287b48d

Extalia adapts bounded navigation/trail behavior from
`src/explore/navigationTrail.ts` and `src/explore/ExploreController.ts`, and
star/edge appearance math and colors from `src/render/NodeTexture.ts`,
`src/render/nodeAppearance.ts`, `src/render/nodeStyle.ts`,
`src/render/EdgeMesh.ts`, and `src/encoding/colorScales.ts`.
Extalia retains its own indexed graph, filters, Three.js renderer, worker and
host-owned note operations. No upstream plugin, Obsidian integration or Pixi.js
runtime is bundled.
Endpoint path gradients are an Extalia adaptation of this appearance direction.

MIT License

Copyright (c) 2026 n23eos

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
