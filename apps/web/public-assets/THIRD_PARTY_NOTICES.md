# Third-party avatar notices

The maintainer supplied these candidate RenderHub source pages for the retained
human base bodies and business outfits. The exact product-to-body match could
not be reconstructed from the existing exports:

- VTR3D, Human Realistic Male Female Base Bodies Game-Ready:
  https://www.renderhub.com/vtr3d/human-realistic-male-female-base-bodies-game-ready
- Renderpeople, Eric Rigged 001:
  https://www.renderhub.com/renderpeople/eric-rigged-001
- Renderpeople, Claudia Rigged 002:
  https://www.renderhub.com/renderpeople/claudia-rigged-002-rigged-3d-business-woman

These pages list RenderHub Extended Use License. Applicable terms:
https://www.renderhub.com/info/3d-content-licensing

The application retains the existing Blender-retargeted bodies and detailed hair
rather than substituting another human model. Their pinned source hashes and sizes
are recorded in tooling/licensed-avatar-sources.json; models.json records the full
public inventory, including separately fitted garments and vehicles below. The two
physical body files serve the four existing appearance variants; identical exports
are not duplicated. Detailed hair retains the existing style fallback. Added and
fitted clothing does not change the separate licenses of its source components.

These avatar assets are not MIT-licensed. Extalia's source code and its original
scene models retain their own license. Avatar source ownership remains with
its respective creators. Detailed hair source evidence and its limits are recorded below.

## Detailed hair attribution

Texture comparisons and source-mesh UV comparisons link the retained styles to
these maintainer-supplied RenderHub Extended Use License archives:

- Short fade and textured crop: Khaloui, Next-Gen 3D Male Hairstyle with Beard
  Mustache PBR Ready. https://www.renderhub.com/khaloui/next-gen-3d-male-hairstyle-with-beard-mustache-pbr-ready
- Slicked back, side part and undercut: Khaloui, Realistic 3D Male Hair Beard
  Mustache Game CGI Ready. https://www.renderhub.com/khaloui/realistic-3d-male-hair-beard-mustache-game-cgi-ready-1
- Female styles use the texture pair from Khaloui, Free Realistic Female Hair.
  https://www.renderhub.com/khaloui/free-realistic-female-hair
  High ponytail, bun and ponytail have source-card UV correspondence. Bob and
  medium retain matching textures, but their complete geometry-edit history
  could not be reconstructed from the retained archives; no exact source-mesh
  claim is made for those two edited styles.

Portable source archive, image and derivative hashes and comparison evidence
are retained in `tooling/licensed-avatar-provenance.json`. These records identify
retained assets; they do not relicense them or grant standalone redistribution.
Future imports must preserve product-to-output provenance records.

## Staff uniforms

The four current uniform files have distinct source records in models.json:

The male receptionist and female bartender uniforms are exported by
`tooling/blender/create-staff-uniforms.py` from the retained licensed avatar
outfits, with project-generated accessories. Their declared asset license remains
RenderHub Extended Use, rather than MIT.

The female receptionist uniform is fitted by `tooling/blender/fit-original-sets.py`
from "Black business suit set"; the male bartender uniform is fitted by
`tooling/blender/fit-original-bartender.py` from "Vest For Ray II". Their original
garment geometry/materials retain CC-BY-4.0; any added avatar skin/context retains
the separate RenderHub Extended Use License. The exact source credits, URLs and
modifications for those two files appear under Original avatar garments below.
Generated additions do not replace those source-component terms.

<!-- campus-vehicles:start -->
## Campus vehicles

The passenger cars in `vehicles/` are simplified derivatives of third-party reference
models, made with `tooling/blender/prepare-campus-vehicles.py` from the catalog
`tooling/blender/campus-vehicles.json`: the interior, badges, logos, lettering and
number-plate text were removed, the geometry was reduced to about 6,000 triangles
(about 10,700 for the traffic-only rigid truck),
wheels were replaced by one generic wheel, and all textures and source colours were
replaced by plain role colours. They are not covered by the project's MIT license;
each file keeps the license recorded for it in models.json.

Brand and model names below only identify the reference model. They are trademarks
of their respective owners; no badge or brand mark is reproduced, and no affiliation
or endorsement is implied.

Files under CC-BY-NC-4.0 or CC-BY-NC-SA-4.0 are for non-commercial use only; the
ShareAlike derivatives are shared under the same CC-BY-NC-SA-4.0 licence.
Building with EXTALIA_COMMERCIAL_ASSETS_ONLY=1 keeps them out of parking and traffic
(see README.md).

### LicenseRef-RenderHub-Extended-Use (renderhub-extended-use)

Free RenderHub downloads under RenderHub's Extended Use License: commercial and non-commercial use in a variety of mediums. Terms: RenderHub 3D Content Licensing Agreement (https://www.renderhub.com/info/3d-content-licensing). The individual RenderHub product pages and authors were not recorded with the archives.

- `vehicles/ev-sedan.glb` (LicenseRef-RenderHub-Extended-Use): 2024 Tesla Model 3; source archive: 2024_tesla_model_3_with_interior.zip. RenderHub free download, Extended Use License (owner-confirmed 2026-10-29); modified: simplified, interior removed, debadged, recoloured.
- `vehicles/ev-sedan-long.glb` (LicenseRef-RenderHub-Extended-Use): 2024 Leapmotor C01; source archive: 2024_leapmotor_c01_with_interior.zip. RenderHub free download, Extended Use License (owner-confirmed 2026-10-29); modified: simplified, interior removed, debadged, recoloured.
- `vehicles/ev-suv.glb` (LicenseRef-RenderHub-Extended-Use): 2025 Xiaomi YU7; source archive: 2025_xiaomi_yu7.zip. RenderHub free download, Extended Use License (owner-confirmed 2026-10-29); modified: simplified, interior removed, debadged, recoloured.
- `vehicles/ev-mpv.glb` (LicenseRef-RenderHub-Extended-Use): 2024 Li Auto MEGA; source archive: 2024_lixiang_mega.zip. RenderHub free download, Extended Use License (owner-confirmed 2026-10-29); modified: simplified, interior removed, debadged, recoloured.
- `vehicles/sedan.glb` (LicenseRef-RenderHub-Extended-Use): 2019 Polestar 1; source archive: polistar_1_2019.zip. RenderHub free download, Extended Use License (owner-confirmed 2026-10-29); modified: simplified, interior removed, debadged, recoloured.
- `vehicles/hatchback.glb` (LicenseRef-RenderHub-Extended-Use): Fiat 500; source archive: fiat_500_3d_model.zip. RenderHub free download, Extended Use License (owner-confirmed 2026-10-29); modified: simplified, interior removed, debadged, recoloured.
- `vehicles/jeep.glb` (LicenseRef-RenderHub-Extended-Use): BAIC BJ40; source archive: baic_bj40_3d_suv.zip. RenderHub free download, Extended Use License (owner-confirmed 2026-10-29); modified: simplified, interior removed, debadged, recoloured.
- `vehicles/mpv.glb` (LicenseRef-RenderHub-Extended-Use): 2021 Honda Odyssey; source archive: 2021_honda_odyssey.zip. RenderHub free download, Extended Use License (owner-confirmed 2026-10-29); modified: simplified, interior removed, debadged, recoloured.
- `vehicles/van.glb` (LicenseRef-RenderHub-Extended-Use): 2010 SsangYong Rodius; source archive: ssangyong_rodius_2010.zip. RenderHub free download, Extended Use License (owner-confirmed 2026-10-29); modified: simplified, interior removed, debadged, recoloured.

### CC-BY-4.0 (sketchfab-ddiaz-huracan-gt3)

This work is based on "2019 Lamborghini Huracán GT3 EVO Racecar" (https://sketchfab.com/3d-models/2019-lamborghini-huracan-gt3-evo-racecar-3cdc43d5cb33454b91434b9d8e2d6bc0) by Ddiaz Design (https://sketchfab.com/ddiaz-design) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, debadged and recoloured (racing livery removed).

- `vehicles/sports.glb` (CC-BY-4.0): 2019 Lamborghini Huracán GT3 EVO Racecar; source archive: lamborghini_huracan_super_trofeo_evo2.zip. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured (racing livery removed).

### CC-BY-4.0 (sketchfab-tsb3dmodels-ranger-raptor)

This work is based on "2019 Ford Ranger Raptor CIVIL (Cities Skylines)" (https://sketchfab.com/3d-models/2019-ford-ranger-raptor-civil-cities-skylines-c2d4113e6acd401cb1999f81bb318325) by TSB3DMODELS (https://sketchfab.com/TSB3DMODELS) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/pickup.glb` (CC-BY-4.0): 2019 Ford Ranger Raptor CIVIL (Cities Skylines); source archive: 2019_ford_ranger_raptor_civil_cities_skylines.glb. Sketchfab, CC-BY-4.0; modified: simplified, debadged, recoloured (texture colours replaced by plain role colours), wheels separated and replaced by the generic wheel.

### CC-BY-4.0 (sketchfab-007-micro-ev)

This work is based on "2020 Wuling Hongguang Mini EV" (https://sketchfab.com/3d-models/2020-wuling-hongguang-mini-ev-d80877acc62d4387a1ed680cf35d54b2) by 007 (https://sketchfab.com/tangwang920) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/micro-ev.glb` (CC-BY-4.0): 2020 Wuling Hongguang Mini EV; source archive: 2020_wuling_hongguang_mini_ev.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-NC-SA-4.0 (sketchfab-ddiaz-design-ev-suv-large)

This work is based on "2023 BYD Yangwang U8" (https://sketchfab.com/3d-models/2023-byd-yangwang-u8-a4990ac098274cb0ae1bc4ddcb977950) by Ddiaz Design (https://sketchfab.com/ddiaz-design) licensed under CC-BY-NC-SA-4.0 (http://creativecommons.org/licenses/by-nc-sa/4.0/). Non-commercial use only. Modified: simplified, interior removed, debadged, recoloured, wheels separated. This derivative is shared under the same licence, CC-BY-NC-SA-4.0. Brand names are trademarks of their owners.

- `vehicles/ev-suv-large.glb` (CC-BY-NC-SA-4.0): 2023 BYD Yangwang U8; source archive: 2023_byd_yangwang_u8.glb. Sketchfab, CC-BY-NC-SA-4.0; non-commercial use only; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-NC-SA-4.0 (sketchfab-ddiaz-design-ev-suv-rugged)

This work is based on "2024 GMC Hummer EV SUV" (https://sketchfab.com/3d-models/2024-gmc-hummer-ev-suv-7cd584fc9ba54acd9002d4286a08e419) by Ddiaz Design (https://sketchfab.com/ddiaz-design) licensed under CC-BY-NC-SA-4.0 (http://creativecommons.org/licenses/by-nc-sa/4.0/). Non-commercial use only. Modified: simplified, interior removed, debadged, recoloured, wheels separated. This derivative is shared under the same licence, CC-BY-NC-SA-4.0. Brand names are trademarks of their owners.

- `vehicles/ev-suv-rugged.glb` (CC-BY-NC-SA-4.0): 2024 GMC Hummer EV SUV; source archive: 2024_gmc_hummer_ev_suv.glb. Sketchfab, CC-BY-NC-SA-4.0; non-commercial use only; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-NC-4.0 (sketchfab-veratech-ev-pickup)

This work is based on "(FREE) 2021 Tesla Cybertruck" (https://sketchfab.com/3d-models/free-2021-tesla-cybertruck-99dd62153e5e4ab1be30013505d54bd3) by veratech (https://sketchfab.com/veratech) licensed under CC-BY-NC-4.0 (http://creativecommons.org/licenses/by-nc/4.0/). Non-commercial use only. Modified: simplified, interior removed, debadged, recoloured, wheels separated. This derivative keeps the licence CC-BY-NC-4.0. Brand names are trademarks of their owners.

- `vehicles/ev-pickup.glb` (CC-BY-NC-4.0): (FREE) 2021 Tesla Cybertruck; source archive: free_2021_tesla_cybertruck.glb. Sketchfab, CC-BY-NC-4.0; non-commercial use only; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-NC-SA-4.0 (sketchfab-ddiaz-design-classic-mini)

This work is based on "1965 Austin Mini Cooper S" (https://sketchfab.com/3d-models/1965-austin-mini-cooper-s-8b063519ced9423db1210bb2423c7d2a) by Ddiaz Design (https://sketchfab.com/ddiaz-design) licensed under CC-BY-NC-SA-4.0 (http://creativecommons.org/licenses/by-nc-sa/4.0/). Non-commercial use only. Modified: simplified, interior removed, debadged, recoloured, wheels separated. This derivative is shared under the same licence, CC-BY-NC-SA-4.0. Brand names are trademarks of their owners.

- `vehicles/classic-mini.glb` (CC-BY-NC-SA-4.0): 1965 Austin Mini Cooper S; source archive: 1965_austin_mini_cooper_s.glb. Sketchfab, CC-BY-NC-SA-4.0; non-commercial use only; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-007-estate)

This work is based on "2013 Audi RS4 Avant" (https://sketchfab.com/3d-models/2013-audi-rs4-avant-a4b718a307d242d4a0b1ac3c55e02e70) by 007 (https://sketchfab.com/tangwang920) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/estate.glb` (CC-BY-4.0): 2013 Audi RS4 Avant; source archive: 2013_audi_rs4_avant.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-007-hot-hatch)

This work is based on "2013 Ford Focus ST" (https://sketchfab.com/3d-models/2013-ford-focus-st-3895f5de52254c73b34ffe295990ec54) by 007 (https://sketchfab.com/tangwang920) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/hot-hatch.glb` (CC-BY-4.0): 2013 Ford Focus ST; source archive: 2013_ford_focus_st.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-007-coupe-suv)

This work is based on "2015 Land- Rover Range Rover Evoque Coupe" (https://sketchfab.com/3d-models/2015-land-rover-range-rover-evoque-coupe-ac88843d4ac841b9837ec9e7c49d50e7) by 007 (https://sketchfab.com/tangwang920) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/coupe-suv.glb` (CC-BY-4.0): 2015 Land- Rover Range Rover Evoque Coupe; source archive: 2015_land-_rover_range_rover_evoque_coupe.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-007-crossover)

This work is based on "2015 Nissan Murano Hybrid" (https://sketchfab.com/3d-models/2015-nissan-murano-hybrid-aaa86c5cca18496e8f637a926df73003) by 007 (https://sketchfab.com/tangwang920) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/crossover.glb` (CC-BY-4.0): 2015 Nissan Murano Hybrid; source archive: 2015_nissan_murano_hybrid.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-007-sports-gt)

This work is based on "2017_mercedes-benz_amg_gt_r" (https://sketchfab.com/3d-models/2017-mercedes-benz-amg-gt-r-d7ea625b376b407298771af9c9129420) by 007 (https://sketchfab.com/tangwang920) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/sports-gt.glb` (CC-BY-4.0): 2017_mercedes-benz_amg_gt_r; source archive: 2017_mercedes-benz_amg_gt_r.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-007-sports-rear-engine)

This work is based on "2017 Porsche 911 (991) GT3 RS" (https://sketchfab.com/3d-models/2017-porsche-911-991-gt3-rs-f98e5c38814146749b202f967084e836) by 007 (https://sketchfab.com/tangwang920) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/sports-rear-engine.glb` (CC-BY-4.0): 2017 Porsche 911 (991) GT3 RS; source archive: 2017_porsche_911_991_gt3_rs.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-007-roadster)

This work is based on "2019 BMW I8 Roadster" (https://sketchfab.com/3d-models/2019-bmw-i8-roadster-b875c94043484973a9b7c9c92e82f4af) by 007 (https://sketchfab.com/tangwang920) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/roadster.glb` (CC-BY-4.0): 2019 BMW I8 Roadster; source archive: 2019_bmw_i8_roadster.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-007-muscle)

This work is based on "2020 Ford Mustang Shelby GT350R" (https://sketchfab.com/3d-models/2020-ford-mustang-shelby-gt350r-81567332164c4bb08c11ef8e37487a9f) by 007 (https://sketchfab.com/tangwang920) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/muscle.glb` (CC-BY-4.0): 2020 Ford Mustang Shelby GT350R; source archive: 2020_ford_mustang_shelby_gt350r.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-007-performance-suv)

This work is based on "2020 Porsche Cayenne Turbo Coupe" (https://sketchfab.com/3d-models/2020-porsche-cayenne-turbo-coupe-275ec998f90b4743a2636bc9d1906811) by 007 (https://sketchfab.com/tangwang920) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/performance-suv.glb` (CC-BY-4.0): 2020 Porsche Cayenne Turbo Coupe; source archive: 2020_porsche_cayenne_turbo_coupe.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-007-suv-luxury)

This work is based on "2022 Hongqi LS7 Guoyao" (https://sketchfab.com/3d-models/2022-hongqi-ls7-guoyao-36932731d5c544ed98394984945bdaee) by 007 (https://sketchfab.com/tangwang920) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/suv-luxury.glb` (CC-BY-4.0): 2022 Hongqi LS7 Guoyao; source archive: 2022_hongqi_ls7_guoyao.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-007-suv-family)

This work is based on "2022 Volkswagen Tiguan L 430 PHEV" (https://sketchfab.com/3d-models/2022-volkswagen-tiguan-l-430-phev-cbab7c2ec1c549bebb6bebf1fed6cbb9) by 007 (https://sketchfab.com/tangwang920) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/suv-family.glb` (CC-BY-4.0): 2022 Volkswagen Tiguan L 430 PHEV; source archive: 2022_volkswagen_tiguan_l_430_phev.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-007-suv-compact)

This work is based on "2023 Hyundai Creta" (https://sketchfab.com/3d-models/2023-hyundai-creta-995cd59ae58b4527b079dc4bf8a36049) by 007 (https://sketchfab.com/tangwang920) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/suv-compact.glb` (CC-BY-4.0): 2023 Hyundai Creta; source archive: 2023_hyundai_creta.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-007-suv-urban)

This work is based on "2023 Hyundai Mufasa" (https://sketchfab.com/3d-models/2023-hyundai-mufasa-fb43aac0ac9c415bbb31a098f90a6538) by 007 (https://sketchfab.com/tangwang920) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/suv-urban.glb` (CC-BY-4.0): 2023 Hyundai Mufasa; source archive: 2023_hyundai_mufasa.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-007-compact-van)

This work is based on "2024 BYD ETP3" (https://sketchfab.com/3d-models/2024-byd-etp3-efced721fd7a404c88f26407c56edb8e) by 007 (https://sketchfab.com/tangwang920) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/compact-van.glb` (CC-BY-4.0): 2024 BYD ETP3; source archive: 2024_byd_etp3.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-tonielpro520-offroad-4door)

This work is based on "2021 Jeep Wrangler" (https://sketchfab.com/3d-models/2021-jeep-wrangler-49a2914dff81428998a76a3043487404) by tonielpro520 (https://sketchfab.com/tonielpro520) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/offroad-4door.glb` (CC-BY-4.0): 2021 Jeep Wrangler; source archive: 2021_jeep_wrangler.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-vinishows-1753d1-suv-midsize)

This work is based on "HAVAL H6 HEV 2024" (https://sketchfab.com/3d-models/haval-h6-hev-2024-5f4841ba0ea344b0b78f1938c6f3dd37) by vinishows-1753d1 (https://sketchfab.com/vinishows-1753d1) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/suv-midsize.glb` (CC-BY-4.0): HAVAL H6 HEV 2024; source archive: haval_h6_hev_2024.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-lexyc16-sports-classic)

This work is based on "Honda NSX 1990" (https://sketchfab.com/3d-models/honda-nsx-1990-1cc15628a00a4739a6b6c01128927c8d) by Lexyc16 (https://sketchfab.com/Lexyc16) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/sports-classic.glb` (CC-BY-4.0): Honda NSX 1990; source archive: honda_nsx_1990.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-mona-x-supercars-city-hatch)

This work is based on "Mini Cooper S Facelift" (https://sketchfab.com/3d-models/mini-cooper-s-facelift-2baca439d2494e02b99596014b49ebd3) by Mona x Supercars (https://sketchfab.com/Car2022) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/city-hatch.glb` (CC-BY-4.0): Mini Cooper S Facelift; source archive: mini_cooper_s_facelift.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-nieve5677-rally-sedan)

This work is based on "Mitsubishi Lancer Evo 5" (https://sketchfab.com/3d-models/mitsubishi-lancer-evo-5-cfc712804d2740e0852ef9ce016b7792) by Nieve5677 (https://sketchfab.com/niev) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/rally-sedan.glb` (CC-BY-4.0): Mitsubishi Lancer Evo 5; source archive: mitsubishi_lancer_evo_5.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-nieve5677-limousine)

This work is based on "Monstrous" (https://sketchfab.com/3d-models/monstrous-219a720fb30c48dfbf543caed454e742) by Nieve5677 (https://sketchfab.com/niev) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/limousine.glb` (CC-BY-4.0): Monstrous; source archive: monstrous.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-carmodifier-pickup-offroad)

This work is based on "PICKUP FORD RAPTOR R" (https://sketchfab.com/3d-models/pickup-ford-raptor-r-4488b718abbb43c793b19ff30d3f703a) by carmodifier (https://sketchfab.com/carmodifier) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/pickup-offroad.glb` (CC-BY-4.0): PICKUP FORD RAPTOR R; source archive: pickup_ford_raptor_r.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-asadawut-kaewma-pickup-midsize)

This work is based on "Toyota Hilux Revo Prerunner 2021" (https://sketchfab.com/3d-models/toyota-hilux-revo-prerunner-2021-04ae6d8e07e84f55a9e1d7e3261be171) by Asadawut.Kaewma (https://sketchfab.com/Asadawut.Kaewma) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/pickup-midsize.glb` (CC-BY-4.0): Toyota Hilux Revo Prerunner 2021; source archive: toyota_hilux_revo_prerunner_2021.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-max-box-truck)

This work is based on "Carrier Truck Renault Premium DXI 440" (https://sketchfab.com/3d-models/carrier-truck-renault-premium-dxi-440-b63d1888fde442ffab2c6534abcee647) by Max (https://sketchfab.com/Max-5532) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/box-truck.glb` (CC-BY-4.0): Carrier Truck Renault Premium DXI 440; source archive: carrier_truck_renault_premium_dxi_440.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### LicenseRef-Sketchfab-Standard (sketchfab-meshava-hypercar)

This work is based on "AC - Mclaren P1 [FREE]" (https://sketchfab.com/3d-models/ac-mclaren-p1-free-747cedadc302451db61deafc85941395) by Meshava (https://sketchfab.com/7093), downloaded from Sketchfab under the Sketchfab Standard licence (https://sketchfab.com/licenses). Modified: simplified, interior removed, debadged, recoloured, wheels separated. The derivative ships only as part of Extalia; it is not offered as a standalone model. Brand names are trademarks of their owners.

- `vehicles/hypercar.glb` (LicenseRef-Sketchfab-Standard): AC - Mclaren P1 [FREE]; source archive: ac_-_mclaren_p1_free.glb. Sketchfab, Sketchfab Standard licence; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-4.0 (sketchfab-boredvicuna8709-pickup-large)

This work is based on "Download Phasmophobia For Pc" (https://sketchfab.com/3d-models/download-phasmophobia-for-pc-d8e1df6ddff14c01a4ef69d7dbc7e060) by BoredVicuna8709 (https://sketchfab.com/BoredVicuna8709) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Modified: simplified, interior removed, debadged, recoloured, wheels separated. Brand names are trademarks of their owners.

- `vehicles/pickup-large.glb` (CC-BY-4.0): Download Phasmophobia For Pc; source archive: download_phasmophobia_for_pc.glb. Sketchfab, CC-BY-4.0; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### CC-BY-NC-SA-4.0 (sketchfab-outpiston-muscle-classic)

This work is based on "1970 Dodge Charger R/T Fast And Furious Edition" (https://sketchfab.com/3d-models/1970-dodge-charger-rt-fast-and-furious-edition-fd195aaa9dad4aefbace532050b7fca6) by OUTPISTON (https://sketchfab.com/OUTPISTON) licensed under CC-BY-NC-SA-4.0 (http://creativecommons.org/licenses/by-nc-sa/4.0/). Non-commercial use only. Modified: simplified, interior removed, debadged, recoloured, wheels separated. This derivative is shared under the same licence, CC-BY-NC-SA-4.0. Brand names are trademarks of their owners.

- `vehicles/muscle-classic.glb` (CC-BY-NC-SA-4.0): 1970 Dodge Charger RT Fast And Furious Edition; source archive: 1970-dodge-charger-rt-fast-and-furious-edition.zip. Sketchfab, CC-BY-NC-SA-4.0; non-commercial use only; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### LicenseRef-Sketchfab-Standard (sketchfab-actsofdoge-suv-classic)

This work is based on "2004 Volvo XC90" (https://sketchfab.com/3d-models/2004-volvo-xc90-0d311477a2934d0aa5c657f0a278b651) by ActsOfDoge (https://sketchfab.com/ActsOfDoge), downloaded from Sketchfab under the Sketchfab Standard licence (https://sketchfab.com/licenses). Modified: simplified, interior removed, debadged, recoloured, wheels separated. The derivative ships only as part of Extalia; it is not offered as a standalone model. Brand names are trademarks of their owners.

- `vehicles/suv-classic.glb` (LicenseRef-Sketchfab-Standard): 2004 Volvo XC90; source archive: 2004-volvo-xc90.zip. Sketchfab, Sketchfab Standard licence; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### LicenseRef-Sketchfab-Standard (sketchfab-actsofdoge-suv-large)

This work is based on "2007 Cadillac Escalade" (https://sketchfab.com/3d-models/2007-cadillac-escalade-af13ac3244d24a678a4f6da97dd72eef) by ActsOfDoge (https://sketchfab.com/ActsOfDoge), downloaded from Sketchfab under the Sketchfab Standard licence (https://sketchfab.com/licenses). Modified: simplified, interior removed, debadged, recoloured, wheels separated. The derivative ships only as part of Extalia; it is not offered as a standalone model. Brand names are trademarks of their owners.

- `vehicles/suv-large.glb` (LicenseRef-Sketchfab-Standard): 2007 Cadillac Escalade; source archive: 2007-cadillac-escalade.zip. Sketchfab, Sketchfab Standard licence; modified: simplified, interior removed, debadged, recoloured, wheels separated.

### LicenseRef-Sketchfab-Standard (sketchfab-actsofdoge-pickup-crew)

This work is based on "2007 GMC Sierra" (https://sketchfab.com/3d-models/2007-gmc-sierra-e81e5adf739949ccaa54a6d00580ff4a) by ActsOfDoge (https://sketchfab.com/ActsOfDoge), downloaded from Sketchfab under the Sketchfab Standard licence (https://sketchfab.com/licenses). Modified: simplified, interior removed, debadged, recoloured, wheels separated. The derivative ships only as part of Extalia; it is not offered as a standalone model. Brand names are trademarks of their owners.

- `vehicles/pickup-crew.glb` (LicenseRef-Sketchfab-Standard): 2007 GMC Sierra; source archive: 2007-gmc-sierra.zip. Sketchfab, Sketchfab Standard licence; modified: simplified, interior removed, debadged, recoloured, wheels separated.

<!-- campus-vehicles:end -->

<!-- avatar-outfits:start -->
## Avatar outfits

Downloaded garment conversions remain local review assets: their sleeve/body correspondence
and seated fit have not passed publication review. The active body-fitted separates are
listed under Avatar wardrobe; facility uniforms retain their own notices.

<!-- avatar-outfits:end -->

<!-- original-garments:start -->
## Original avatar garments

These garments use the original owner-provided GLB meshes and native materials, not replacement templates.
The source garment geometry and textures are licensed under CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/).
Body-specific fitting and skeletal binding adapt them for the Office. Hidden panels of the non-standalone
jacket inner are local review material; only its independently wearable outer is distributed.
Any added avatar skin/context keeps its separate RenderHub Extended Use License:
https://www.renderhub.com/info/3d-content-licensing. Those parts are not relicensed under CC-BY or MIT.

- `avatars/outfits/female/outfit-original-dress.glb` (CC-BY-4.0): "Dress" by Andrew Lebedev (https://sketchfab.com/Andrew_Lebedev_CGI); https://sketchfab.com/3d-models/dress-e91b8bff85094f7cb0aa564e4df01a39. Modified: body fit, skeletal binding and garment separation; original UVs and texture maps retained.
- `avatars/outfits/female/reception-uniform.glb` (CC-BY-4.0): "Black business suit set" by Style3D CG (https://sketchfab.com/Style3DMeta); https://sketchfab.com/3d-models/black-business-suit-set-3d61d6d1a6bc400898709f0a92ac9105. Modified: body fit, skeletal binding and garment separation; original UVs and texture maps retained.
- `avatars/outfits/male/bartender-uniform.glb` (CC-BY-4.0): "Vest For Ray II" by ChamberSu1996 (https://sketchfab.com/chambersu1996); https://sketchfab.com/3d-models/vest-for-ray-ii-15e2b92a3ca3474693412baf48343e09. Modified: body fit, skeletal binding and garment separation; original UVs and texture maps retained.
- `avatars/wardrobe/female/bottom/short-jeans.glb` (CC-BY-4.0): "female short jeans" by Toxic (https://sketchfab.com/wutianci); https://sketchfab.com/3d-models/female-short-jeans-6b42c4a5591e4122940bd0fccde6f2f8. Modified: body fit, skeletal binding and garment separation; original UVs and texture maps retained.
- `avatars/wardrobe/female/outer/cloth-jacket.glb` (CC-BY-4.0): "Cloth Jacket" by Curtis Kinney (https://sketchfab.com/ravenkumquat); https://sketchfab.com/3d-models/cloth-jacket-f880b45cde9f41cf9b4afbfe25ce9887. Modified: body fit, skeletal binding and garment separation; original UVs and texture maps retained.
- `avatars/wardrobe/male/bottom/jeans.glb` (CC-BY-4.0): "Hoodie and Jeans" by lizhiqiang (https://sketchfab.com/lizhiqiang89); https://sketchfab.com/3d-models/hoodie-and-jeans-4fc7bc06a5b94568b1923268f4a6e825. Modified: body fit, skeletal binding and garment separation; original UVs and texture maps retained.

<!-- original-garments:end -->

<!-- source-garments:start -->
## Reviewed source avatar garments

Original garment geometry, fabric motifs, textures and native material maps are retained.
The source garments listed below are CC-BY-4.0; attribution and source URLs are per asset.
CC-BY-4.0 terms: https://creativecommons.org/licenses/by/4.0/.
The reference avatar rig and any added skin/context retain the separate RenderHub Extended Use License
(https://www.renderhub.com/info/3d-content-licensing); those components are not relicensed as CC-BY or MIT.

- `avatars/outfits/female/outfit-source-cheongsam-blue.glb` (CC-BY-4.0): "Blue White Floral Cheongsam dress" by Style3D CG (https://sketchfab.com/Style3DMeta); https://sketchfab.com/3d-models/blue-white-floral-cheongsam-dress-01f1e45152cd490faabd7f5effdf178c. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/outfits/female/outfit-source-denim-dress.glb` (CC-BY-4.0): "Woman Dress" by Ali Şahan Yalçın (https://sketchfab.com/alisahanyalcin); https://sketchfab.com/3d-models/woman-dress-7f36459d7f7b43548d56e63d899d7354. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/outfits/female/outfit-source-jumper-skirt.glb` (CC-BY-4.0): "puff sleeve and jumper (skirt)" by Takeru (https://sketchfab.com/takeru1124); https://sketchfab.com/3d-models/puff-sleeve-and-jumper-skirt-1f94546fb3c04051957958098fe1ee06. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/outfits/female/outfit-source-polka-dress.glb` (CC-BY-4.0): "Polka Dot Dress" by Style3D CG (https://sketchfab.com/Style3DMeta); https://sketchfab.com/3d-models/polka-dot-dress-c27c8df7e86c4537b528401b3ccf6e74. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/outfits/female/outfit-source-skirt-tee.glb` (CC-BY-4.0): "Skirt and t-shirt" by Virtual Pandora (https://sketchfab.com/virtualpandora); https://sketchfab.com/3d-models/skirt-and-t-shirt-e0ea80504d914211a96a8c36a4e1a4db. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/outfits/male/outfit-black-business-suit.glb` (CC-BY-4.0): "Man Black Business Suit" by Style3D CG (https://sketchfab.com/Style3DMeta); https://sketchfab.com/3d-models/man-black-business-suit-7a669a06fb954d459985ccaa98672177. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/outfits/male/outfit-mens-two-piece-suit.glb` (CC-BY-4.0): "Men's Two Piece Suit" by DineshThennarasan (https://sketchfab.com/dineshthennarasan); https://sketchfab.com/3d-models/mens-two-piece-suit-8cafbab7a73e4fb7966a00659a4e31ef. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/outfits/male/outfit-printed-hoodie-jeans.glb` (CC-BY-4.0): "Hoodie and Jeans" by lizhiqiang (https://sketchfab.com/lizhiqiang89); https://sketchfab.com/3d-models/hoodie-and-jeans-4fc7bc06a5b94568b1923268f4a6e825. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/outfits/male/outfit-prom-suit.glb` (CC-BY-4.0): "Prom Suit" by jpg. (https://sketchfab.com/jpg.); https://sketchfab.com/3d-models/prom-suit-a0d13b4678684e5ab62b08d4a8ef1835. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/outfits/male/outfit-sweatshirt-jacket-workwear.glb` (CC-BY-4.0): "Sweatshirt and jacket and workwear pants" by Style3D CG (https://sketchfab.com/Style3DMeta); https://sketchfab.com/3d-models/sweatshirt-and-jacket-and-workwear-pants-ceabc26ccd8a48ed9dea753c6f7bcd2e. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/outfits/male/outfit-victorian-bartender.glb` (CC-BY-4.0): "a set of Victorian clothes" by deymar (https://sketchfab.com/deymar); https://sketchfab.com/3d-models/a-set-of-victorian-clothes-cfe0ad26828a42cebf49aea928ea8a15. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/wardrobe/female/bottom/source-gothic-skirt.glb` (CC-BY-4.0): "Women's blouse and skirt" by ps2enthusiast (https://sketchfab.com/kosicky.jozef2308); https://sketchfab.com/3d-models/womens-blouse-and-skirt-f9d46dfe0bf4431195f4044861ce568f. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/wardrobe/female/bottom/source-gothic-trousers.glb` (CC-BY-4.0): "Women's blouse and skirt" by ps2enthusiast (https://sketchfab.com/kosicky.jozef2308); https://sketchfab.com/3d-models/womens-blouse-and-skirt-f9d46dfe0bf4431195f4044861ce568f. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/wardrobe/female/bottom/source-ray-trousers.glb` (CC-BY-4.0): "Real Suit For Ray II Retopo" by ChamberSu1996 (https://sketchfab.com/chambersu1996); https://sketchfab.com/3d-models/real-suit-for-ray-ii-retopo-3e543b8199f548cf99077c89929888b5. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/wardrobe/female/outer/source-leather-cloak.glb` (CC-BY-4.0): "Old leather cloak (female)" by KIFIR (https://sketchfab.com/kifir); https://sketchfab.com/3d-models/old-leather-cloak-female-e81f214036f34635bccfce842da6a13d. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/wardrobe/female/outer/source-overcoat.glb` (CC-BY-4.0): "Female Overcoat" by 3DGunsmith (https://sketchfab.com/3DGunsmith); https://sketchfab.com/3d-models/female-overcoat-4bc89e3be7fb4c11b3b1153e9ea384dd. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/wardrobe/female/outer/source-ray-vest.glb` (CC-BY-4.0): "Real Suit For Ray II Retopo" by ChamberSu1996 (https://sketchfab.com/chambersu1996); https://sketchfab.com/3d-models/real-suit-for-ray-ii-retopo-3e543b8199f548cf99077c89929888b5. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/wardrobe/female/outer/source-red-leather-jacket.glb` (CC-BY-4.0): "Red Leather Jacket" by kmichy (https://sketchfab.com/kmichy); https://sketchfab.com/3d-models/red-leather-jacket-33e80ed4b76d4a8397e669ce66493374. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/wardrobe/female/top/source-belted-top.glb` (CC-BY-4.0): "Women Top with belt" by Annie88 (https://sketchfab.com/LIU_CG); https://sketchfab.com/3d-models/women-top-with-belt-9b0d33a10d8345e682d2e642703210f7. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/wardrobe/female/top/source-female-cloth1.glb` (CC-BY-4.0): "Female Cloth1" by mega3d (https://sketchfab.com/mega-3d); https://sketchfab.com/3d-models/female-cloth1-c5f828cf2c52461496a058f590e26cd6. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/wardrobe/female/top/source-flame-hoodie.glb` (CC-BY-4.0): "Classic Black Flame Hoodie" by kril (https://sketchfab.com/krrril_); https://sketchfab.com/3d-models/classic-black-flame-hoodie-0fd0effa321e456cb2a7467e2899b658. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/wardrobe/female/top/source-gothic-blouse.glb` (CC-BY-4.0): "Women's blouse and skirt" by ps2enthusiast (https://sketchfab.com/kosicky.jozef2308); https://sketchfab.com/3d-models/womens-blouse-and-skirt-f9d46dfe0bf4431195f4044861ce568f. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/wardrobe/female/top/source-oversize-shirt.glb` (CC-BY-4.0): "Low poly woman oversize shirt with tie" by rkuzmin260 (https://sketchfab.com/rkuzmin260); https://sketchfab.com/3d-models/low-poly-woman-oversize-shirt-with-tie-8f0c1d170b1d4f38b9ba23a11cc4a87c. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/wardrobe/female/top/source-pink-hoodie.glb` (CC-BY-4.0): "Pink Drawstring Hooded Sweatshirt" by Style3D CG (https://sketchfab.com/Style3DMeta); https://sketchfab.com/3d-models/pink-drawstring-hooded-sweatshirt-fd03f442026f4252b2507dda53bba564. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/wardrobe/female/top/source-ray-underlayer.glb` (CC-BY-4.0): "Real Suit For Ray II Retopo" by ChamberSu1996 (https://sketchfab.com/chambersu1996); https://sketchfab.com/3d-models/real-suit-for-ray-ii-retopo-3e543b8199f548cf99077c89929888b5. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/wardrobe/male/outer/denim-jacket.glb` (CC-BY-4.0): "Denim Jacket" by k_Helferty99 (https://sketchfab.com/k_Helferty99); https://sketchfab.com/3d-models/denim-jacket-1f11ec52bd8c4421abc18f45197c198e. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.
- `avatars/wardrobe/male/top/green-white-hoodie.glb` (CC-BY-4.0): "Green and white hoodie" by Style3D CG (https://sketchfab.com/Style3DMeta); https://sketchfab.com/3d-models/green-and-white-hoodie-af100701826e4bb9abc1ff1a1d24ab1e. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.

Detail LOD for `avatars/wardrobe/female/top/source-flame-hoodie.glb`: modeled stitch meshes use an explicit reviewed reduction; primary fabric geometry and UV corners remain unchanged.

<!-- source-garments:end -->
