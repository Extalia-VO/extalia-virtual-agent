/*! @license
 * Reference core/fog style adapted from Advanced Graph View, copyright (c) 2026 n23eos (MIT).
 * src/render/NodeTexture.ts, nodeStyle.ts, nodeAppearance.ts at
 * https://github.com/n23eos/advanced_graph_view/tree/17e3eb1fd0e64d4d13d9a130c4bd77b2f287b48d
 * License: apps/web/public/THIRD_PARTY_SOFTWARE.md.
 */
import { NormalBlending, ShaderMaterial, UniformsLib, UniformsUtils } from 'three';
import { GRAPH_NODE_FOG_FLOOR } from './graphReferenceStyle';

/** Compact emissive discs: one instanced billboard draw, independent of scene lighting. */
export function createGraphNodeMaterial() {
  return new ShaderMaterial({
    transparent: true, blending: NormalBlending, depthWrite: true, depthTest: true,
    fog: true, toneMapped: false,
    uniforms: {
      ...UniformsUtils.clone(UniformsLib.fog),
      uLight: { value: 0 },
      uViewportHeight: { value: 1 },
    },
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      uniform float uViewportHeight;
      varying vec3 vGraphColour;
      varying vec2 vGraphUv;
      void main() {
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float worldRadius = length(instanceMatrix[0].xyz);
        float viewDepth = max(-mvPosition.z, 0.0001);
        float pixelsPerWorldUnit = projectionMatrix[1][1] * max(uViewportHeight, 1.0) / (2.0 * viewDepth);
        // Clamp in CSS pixels, without bringing filtered (zero-scale) instances back.
        float radius = worldRadius > 0.0
          ? clamp(worldRadius * pixelsPerWorldUnit, 1.2, 6.0) / pixelsPerWorldUnit
          : 0.0;
        mvPosition.xy += position.xy * radius;
        vGraphColour = instanceColor;
        vGraphUv = uv;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <fog_pars_fragment>
      uniform float uLight;
      varying vec3 vGraphColour;
      varying vec2 vGraphUv;
      void main() {
        float radialDistance = length(vGraphUv * 2.0 - 1.0);
        float edgeWidth = max(fwidth(radialDistance), 0.001);
        float alpha = 1.0 - smoothstep(1.0 - edgeWidth, 1.0, radialDistance);
        if (alpha <= 0.0) discard;
        // Reference star textures have a flat opaque core, with the glow in a
        // separate transparent layer. Light themes use the reference flat style.
        vec3 emissive = vGraphColour * 1.4;
        vec3 ink = vGraphColour * 0.34;
        vec3 colour = mix(emissive, ink, uLight);
        gl_FragColor = vec4(colour, alpha);
        // Retain the reference's far-node visibility floor instead of allowing
        // Three's fog to erase drawn notes. Zero-scale instances stay hidden.
        #ifdef USE_FOG
          #ifdef FOG_EXP2
            float graphFog = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
          #else
            float graphFog = smoothstep(fogNear, fogFar, vFogDepth);
          #endif
          gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, graphFog * ${1 - GRAPH_NODE_FOG_FLOOR} * (1.0 - uLight));
        #endif
        #include <colorspace_fragment>
      }
    `,
  });
}
