"""Standard-library publication checks, using synthetic GLBs in temporary projects only."""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


P = module('source_publication_checks', 'publish-source-garments.py')
F = module('source_publication_fixtures', 'check-original-gltf-materials.py')
G = P.G


class SourcePublicationChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / 'project'
        self.sources = Path(self.temporary.name) / 'sources'
        self.public = self.root / 'apps/web/public-assets'
        self.local = self.root / 'apps/web/local-assets/avatars'
        self.public.mkdir(parents=True)
        self.old_entry = {'path': 'existing.glb', 'license': 'MIT', 'sha256': '0' * 64, 'bytes': 0}
        (self.public / 'models.json').write_text(json.dumps({'schemaVersion': 1, 'models': [self.old_entry]}))
        (self.public / 'THIRD_PARTY_NOTICES.md').write_text('Existing credits remain unchanged.\n')
        self.recipes = self.root / 'tooling/blender'
        self.recipes.mkdir(parents=True)
        (self.recipes / 'source-garments-female.json').write_text(json.dumps({'schemaVersion': 1, 'group': 'female', 'entries': []}))
        self.source = self.sources / 'male/pattern.glb'
        self.source.parent.mkdir(parents=True)
        self.fitted = self.local / 'all-garment-review/fitted/male/pattern.glb'
        self.fitted.parent.mkdir(parents=True)
        self.make_candidate()

    def rewrite(self, path, callback):
        _raw, document, binary, chunks = G._read_glb(path)
        callback(document)
        path.write_bytes(G._encode_glb(document, binary, chunks))

    def make_candidate(self, license='CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/)'):
        material = {'name': 'Fabric', 'pbrMetallicRoughness': {'baseColorTexture': {'index': 0, 'texCoord': 1},
                    'baseColorFactor': [.4, .5, .6, 1]}, 'alphaMode': 'OPAQUE'}
        F.fixture(self.source, [material], [F.png((10, 120, 240, 255))], [{'source': 0, 'sampler': 0}], source=True)
        self.rewrite(self.source, lambda document: document['asset'].update(extras={
            'title': 'Synthetic fabric', 'author': 'Fixture Author (https://example.com/author)',
            'source': 'https://example.com/garment', 'license': license}))
        F.fixture(self.fitted, [{'name': 'OriginalTop_Fabric', 'extras': {'privateDraft': 'remove me'}}], [], [])
        _raw, document, binary, chunks = G._read_glb(self.fitted)
        packed = bytearray(binary)
        def accessor(payload, component, kind, count):
            packed.extend(b'\0' * (-len(packed) % 4))
            document['bufferViews'].append({'buffer': 0, 'byteOffset': len(packed), 'byteLength': len(payload)})
            packed.extend(payload)
            document['accessors'].append({'bufferView': len(document['bufferViews']) - 1,
                                          'componentType': component, 'type': kind, 'count': count})
            return len(document['accessors']) - 1
        joints = accessor(bytes(12), 5121, 'VEC4', 3)
        weights = accessor(struct.pack('<12f', *([1, 0, 0, 0] * 3)), 5126, 'VEC4', 3)
        identity = [1 if column == row else 0 for column in range(4) for row in range(4)]
        inverse = accessor(struct.pack('<320f', *(identity * 20)), 5126, 'MAT4', 20)
        document['buffers'][0]['byteLength'] = len(packed)
        document['meshes'][0]['primitives'][0]['attributes'].update(JOINTS_0=joints, WEIGHTS_0=weights)
        names = ['root', 'hips', 'spine', 'chest', 'neck', 'head', 'leftShoulder', 'leftUpperArm',
                 'leftLowerArm', 'leftHand', 'rightShoulder', 'rightUpperArm', 'rightLowerArm',
                 'rightHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg',
                 'rightLowerLeg', 'rightFoot']
        document['nodes'] = [{'mesh': 0, 'skin': 0, 'extras': {'extaliaOwnHands': True, 'privateDraft': 'remove me'}}]
        document['nodes'] += [{'name': name} for name in names]
        document['nodes'][1]['children'] = list(range(2, 21))
        document['skins'] = [{'joints': list(range(1, 21)), 'inverseBindMatrices': inverse, 'skeleton': 1}]
        document['scenes'][0]['nodes'] = [0, 1]
        self.fitted.write_bytes(G._encode_glb(document, bytes(packed), chunks))
        fidelity = G.graft_source_materials(self.source, self.fitted, {'OriginalTop_Fabric': 0})
        self.sidecar = {'id': 'pattern', 'group': 'male', 'source': 'male/pattern.glb', 'mode': 'top',
                        'stats': {'triangles': 1}, 'fidelity': fidelity}
        self.recipe = {'id': 'pattern', 'source': 'male/pattern.glb', 'mode': 'top', 'publish': True,
                       'review': {'status': 'passed', 'fittedSHA256': fidelity['outputSHA256'],
                       'budgets': {'triangles': 1, 'bytes': len(self.fitted.read_bytes()) + 4096},
                       'fitChecks': {key: True for key in P.CHECKS}}}
        self.save()

    def save(self):
        self.fitted.with_suffix('.source.json').write_text(json.dumps(self.sidecar))
        (self.recipes / 'source-garments-male.json').write_text(json.dumps(
            {'schemaVersion': 1, 'group': 'male', 'entries': [self.recipe]}))

    def reapprove_modified_candidate(self):
        digest = P.sha(self.fitted.read_bytes())
        self.sidecar['fidelity']['outputSHA256'] = digest
        self.recipe['review']['fittedSHA256'] = digest
        self.save()

    def run_publisher(self, dry_run=False):
        return P.publish(self.sources, dry_run=dry_run, root=self.root)

    def test_no_approval_and_dry_run_never_promote(self):
        self.recipe.pop('review'); self.recipe['publish'] = False; self.save()
        self.assertEqual(self.run_publisher()['approved'], 0)
        self.assertFalse((self.public / 'source-garments.json').exists())
        self.make_candidate()
        before = (self.public / 'models.json').read_bytes()
        summary = self.run_publisher(dry_run=True)
        self.assertEqual((summary['approved'], summary['public'], summary['writes']), (1, 1, 0))
        self.assertEqual((self.public / 'models.json').read_bytes(), before)
        self.assertFalse((self.public / 'avatars').exists())

    def test_public_promotion_preserves_existing_records_and_native_graphs(self):
        summary = self.run_publisher()
        self.assertEqual((summary['public'], summary['localOnly']), (1, 0))
        target = self.public / 'avatars/wardrobe/male/top/pattern.glb'
        _raw, document, binary, _chunks = G._read_glb(target)
        self.assertTrue(document['nodes'][0]['extras']['extaliaOwnHands'])
        self.assertNotIn('privateDraft', document['nodes'][0]['extras'])
        self.assertNotIn('extras', document['materials'][0])
        public_rows = json.loads((self.public / 'models.json').read_text())['models']
        self.assertIn(self.old_entry, public_rows)
        notice = (self.public / 'THIRD_PARTY_NOTICES.md').read_text()
        self.assertTrue(notice.startswith('Existing credits remain unchanged.\n'))
        self.assertIn('RenderHub Extended Use License', notice)
        profile = json.loads((self.public / 'source-garments.json').read_text())['garments'][0]
        actual = G._material_receipt(document, binary, document['materials'][0])
        self.assertEqual(profile['materials']['OriginalTop_Fabric']['graphSHA256'], actual['graphSHA256'])
        self.assertEqual(profile['sha256'], P.sha(target.read_bytes()))
        self.assertEqual(self.run_publisher()['public'], 1)
        self.assertEqual((self.public / 'THIRD_PARTY_NOTICES.md').read_text(), notice)

    def test_standard_is_local_only_with_attribution(self):
        self.make_candidate('SKETCHFAB Standard (https://sketchfab.com/licenses)')
        with self.assertRaisesRegex(ValueError, 'Standard assets require publish=false'):
            self.run_publisher()
        self.assertFalse((self.public / 'avatars').exists())
        self.recipe['publish'] = False; self.save()
        before = (self.public / 'models.json').read_bytes()
        summary = self.run_publisher()
        self.assertEqual((summary['public'], summary['localOnly']), (0, 1))
        self.assertTrue((self.local / 'wardrobe/male/top/pattern.glb').exists())
        local = json.loads((self.local / 'reviewed-source-garments.json').read_text())['garments'][0]
        self.assertTrue(local['localOnly'])
        self.assertEqual(local['attribution']['source'], 'https://example.com/garment')
        self.assertEqual((self.public / 'models.json').read_bytes(), before)
        self.assertFalse((self.public / 'source-garments.json').exists())

    def test_approved_cc_by_can_remain_local_when_publication_is_disabled(self):
        self.recipe['publish'] = False; self.save()
        summary = self.run_publisher()
        self.assertEqual((summary['public'], summary['localOnly']), (0, 1))
        local = json.loads((self.local / 'reviewed-source-garments.json').read_text())['garments'][0]
        self.assertTrue(local['localOnly'])
        self.assertEqual(local['license'], 'CC-BY-4.0')
        self.assertFalse((self.public / 'avatars').exists())
        self.assertFalse((self.public / 'source-garments.json').exists())

    def test_stale_source_review_receipt_and_budgets_reject_without_writes(self):
        base_recipe, base_sidecar = deepcopy(self.recipe), deepcopy(self.sidecar)
        for change in ('review', 'receipt', 'budget', 'fitChecks'):
            self.recipe, self.sidecar = deepcopy(base_recipe), deepcopy(base_sidecar)
            if change == 'review': self.recipe['review']['fittedSHA256'] = '0' * 64
            elif change == 'receipt': self.sidecar['fidelity']['materials']['OriginalTop_Fabric']['graphSHA256'] = '0' * 64
            elif change == 'budget': self.recipe['review']['budgets']['bytes'] = 1
            else: self.recipe['review']['fitChecks']['sit'] = False
            self.save()
            with self.subTest(change=change), self.assertRaises(ValueError): self.run_publisher()
            self.assertFalse((self.public / 'avatars').exists())
        self.recipe, self.sidecar = base_recipe, base_sidecar; self.save()
        self.rewrite(self.source, lambda document: document['asset'].update(copyright='Source changed'))
        with self.assertRaisesRegex(ValueError, 'source hash'): self.run_publisher()

    def test_reapproved_graph_uv_and_sanitizer_damage_still_reject(self):
        for change in ('graph', 'uv', 'sanitizer'):
            self.make_candidate()
            if change == 'graph':
                self.rewrite(self.fitted, lambda document: document['materials'][0]['pbrMetallicRoughness'].update(baseColorFactor=[1, 0, 0, 1]))
                self.reapprove_modified_candidate()
            elif change == 'uv':
                self.rewrite(self.fitted, lambda document: document['meshes'][0]['primitives'][0]['attributes'].pop('TEXCOORD_1'))
                self.reapprove_modified_candidate()
            original = P.PUBLIC.public_glb
            if change == 'sanitizer':
                def damaged(*args, **kwargs):
                    data = bytearray(original(*args, **kwargs))
                    size = struct.unpack_from('<I', data, 12)[0]
                    document = json.loads(data[20:20 + size])
                    view = document['bufferViews'][document['images'][-1]['bufferView']]
                    cursor = 20 + size
                    while cursor < len(data):
                        length, kind = struct.unpack_from('<II', data, cursor)
                        if kind == G.BIN_CHUNK:
                            data[cursor + 8 + view.get('byteOffset', 0)] ^= 1
                            break
                        cursor += 8 + length
                    return bytes(data)
                P.PUBLIC.public_glb = damaged
            try:
                with self.subTest(change=change), self.assertRaises(ValueError): self.run_publisher()
                self.assertFalse((self.public / 'avatars').exists())
            finally:
                P.PUBLIC.public_glb = original

    def test_reapproved_uv_coordinates_and_invalid_skin_cannot_promote(self):
        for change in ('uv-values', 'five-influences', 'non-normalized-weights'):
            self.make_candidate()
            _raw, document, binary, chunks = G._read_glb(self.fitted)
            attrs = document['meshes'][0]['primitives'][0]['attributes']
            if change == 'five-influences':
                attrs['WEIGHTS_1'] = attrs['WEIGHTS_0']
            else:
                accessor = document['accessors'][attrs['TEXCOORD_1' if change == 'uv-values' else 'WEIGHTS_0']]
                view = document['bufferViews'][accessor['bufferView']]
                offset = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
                binary = bytearray(binary)
                value = struct.unpack_from('<f', binary, offset)[0]
                struct.pack_into('<f', binary, offset, value + .1)
            self.fitted.write_bytes(G._encode_glb(document, bytes(binary), chunks))
            self.reapprove_modified_candidate()
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'UV corners|skin|influence'):
                self.run_publisher()
            self.assertFalse((self.public / 'avatars').exists())

    def test_flame_exception_never_allows_primary_deletion_or_uv_loss(self):
        recipe = {'id': 'source-flame-hoodie', 'source': 'female/classic_black_flame_hoodie.glb',
                  'partLod': [['stitch', 10000]], 'detailObjects': ['stitch']}
        source = {'meshes': [{'name': 'Primary fabric', 'primitives': [{'material': 0}]},
                             {'name': 'Modeled stitches', 'primitives': [{'material': 3}]}]}
        proof = {'match': False, 'materials': [
            {'sourceMaterialIndex': 0, 'sourceTriangles': 2, 'fittedTriangles': 2,
             'triangleCountsMatch': True, 'layers': [{'match': True}]},
            {'sourceMaterialIndex': 3, 'sourceTriangles': 20, 'fittedTriangles': 10,
             'triangleCountsMatch': False, 'layers': [{'match': False}]}]}
        sidecar = {'stats': {'sourceLod': {'primaryUnchanged': True, 'primaryTriangles': 2, 'parts': [
            {'object': 'Primary fabric', 'detail': False, 'trianglesBefore': 2, 'trianglesAfter': 2, 'target': None},
            {'object': 'Modeled stitches', 'detail': True, 'trianglesBefore': 20, 'trianglesAfter': 10, 'target': 10000}]}}}
        with patch.object(P.UV, 'audit', return_value=proof), patch.object(P.UV, 'read_glb', return_value=(source, b'', 'source')):
            self.assertEqual(P.verify_source_corners(self.source, self.fitted, sidecar, recipe),
                             {'primaryExact': True, 'detailLOD': True})
        for change in ('primary-triangles', 'primary-uv', 'primary-provenance', 'detail-deleted', 'unapproved-source'):
            pr, sc, rc = deepcopy(proof), deepcopy(sidecar), deepcopy(recipe)
            if change == 'primary-triangles': pr['materials'][0]['triangleCountsMatch'] = False
            elif change == 'primary-uv': pr['materials'][0]['layers'][0]['match'] = False
            elif change == 'primary-provenance': sc['stats']['sourceLod']['parts'][0]['trianglesAfter'] = 1
            elif change == 'detail-deleted': sc['stats']['sourceLod']['parts'][1]['trianglesAfter'] = 0
            else: rc['id'] = 'another-garment'
            with self.subTest(change=change), patch.object(P.UV, 'audit', return_value=pr), \
                    patch.object(P.UV, 'read_glb', return_value=(source, b'', 'source')), self.assertRaises(ValueError):
                P.verify_source_corners(self.source, self.fitted, sc, rc)

    def test_detail_notices_preserve_credits_and_explain_only_current_lods(self):
        credit, _license = P.credit(G._read_glb(self.source)[1])
        first, second = 'avatars/wardrobe/female/top/source-flame-hoodie.glb', 'avatars/wardrobe/male/top/pattern.glb'
        text = P.notices('Existing credit.\n', {first: credit}, {first})
        self.assertIn('Detail LOD for `' + first + '`', text)
        self.assertIn('primary fabric geometry and UV corners remain unchanged', text)
        self.assertEqual(P.notices(text, {first: credit}, {first}), text)
        # An unrelated later promotion keeps the earlier explicit detail credit.
        later = P.notices(text, {second: credit})
        self.assertIn('Detail LOD for `' + first + '`', later)
        # A later full-detail replacement must not retain a stale LOD statement.
        self.assertNotIn('Detail LOD for `' + first + '`', P.notices(later, {first: credit}))


if __name__ == '__main__':
    unittest.main()
