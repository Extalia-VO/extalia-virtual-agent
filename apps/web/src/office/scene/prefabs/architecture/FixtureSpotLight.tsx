import { FixtureSpotLight as BakedFixtureSpotLight } from '../../interior/prefabs/architecture/FixtureSpotLight';

type FixtureSpotLightProps = Parameters<typeof BakedFixtureSpotLight>[0];

/**
 * Architectural wrapper around the shared `FixtureSpotLight` implementation so both
 * shadowed moving beams (such as the panoramic elevator cabin) and baked static beams work.
 */
export function FixtureSpotLight(props: FixtureSpotLightProps) {
  return <BakedFixtureSpotLight {...props} />;
}
