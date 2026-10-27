/** The small part of `d3-force-3d` (MIT, no bundled types) the vault graph simulation uses. */
declare module 'd3-force-3d' {
  export interface SimNode { index?: number; x?: number; y?: number; z?: number; vx?: number; vy?: number; vz?: number; fx?: number | null; fy?: number | null; fz?: number | null }
  export interface SimLink<N extends SimNode> { source: number | N; target: number | N; index?: number }
  type Accessor<T, R> = R | ((datum: T, index: number, data: T[]) => R);

  export interface Force<N extends SimNode> { (alpha: number): void; initialize?(nodes: N[], ...rest: unknown[]): void }
  export interface Simulation<N extends SimNode> {
    tick(iterations?: number): this;
    stop(): this;
    restart(): this;
    nodes(): N[];
    nodes(nodes: N[]): this;
    alpha(): number;
    alpha(value: number): this;
    alphaMin(): number;
    alphaMin(value: number): this;
    alphaDecay(value: number): this;
    alphaTarget(): number;
    alphaTarget(value: number): this;
    velocityDecay(value: number): this;
    numDimensions(value: number): this;
    force(name: string): Force<N> | undefined;
    force(name: string, force: Force<N> | null): this;
  }
  export interface LinkForce<N extends SimNode> extends Force<N> {
    links(links: SimLink<N>[]): this;
    distance(value: Accessor<SimLink<N>, number>): this;
    strength(value: Accessor<SimLink<N>, number>): this;
    iterations(value: number): this;
  }
  export interface ManyBodyForce<N extends SimNode> extends Force<N> {
    strength(value: Accessor<N, number>): this;
    theta(value: number): this;
    distanceMin(value: number): this;
    distanceMax(value: number): this;
  }
  export interface PositionForce<N extends SimNode> extends Force<N> { strength(value: Accessor<N, number>): this }
  export function forceSimulation<N extends SimNode>(nodes?: N[], numDimensions?: number): Simulation<N>;
  export function forceLink<N extends SimNode>(links?: SimLink<N>[]): LinkForce<N>;
  export function forceManyBody<N extends SimNode>(): ManyBodyForce<N>;
  export function forceX<N extends SimNode>(x?: number): PositionForce<N>;
  export function forceY<N extends SimNode>(y?: number): PositionForce<N>;
  export function forceZ<N extends SimNode>(z?: number): PositionForce<N>;
}
