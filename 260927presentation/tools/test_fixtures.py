"""Check generated PDF structures independently of Android PdfRenderer."""
import unittest
import generate_fixtures as fixtures


class FixtureTests(unittest.TestCase):
    def test_cross_references_and_page_count(self):
        for name, data in fixtures.fixtures().items():
            if not name.startswith('demo'):
                continue
            with self.subTest(name=name):
                self.assertEqual(3, data.count(b'/Type /Page '))
                offset = int(data.split(b'startxref\n')[1].splitlines()[0])
                self.assertEqual(b'xref', data[offset:offset+4])
                lines = data[offset:].splitlines()
                count = int(lines[1].split()[1])
                for index in range(1, count):
                    obj_offset = int(lines[2+index].split()[0])
                    self.assertTrue(data[obj_offset:].startswith(f'{index} 0 obj'.encode()))

    def test_dimensions_rotation_prefix_and_font_policy(self):
        files = fixtures.fixtures()
        self.assertIn(b'/MediaBox [0 0 960 540]', files['demo.pdf'])
        self.assertIn(b'/MediaBox [0 0 720 540]', files['demo-4x3.pdf'])
        self.assertIn(b'/MediaBox [0 0 540 960]', files['demo-portrait.pdf'])
        self.assertIn(b'/Rotate 90', files['demo-rotated.pdf'])
        self.assertGreater(files['demo-prefixed.pdf'].index(b'%PDF-'), 0)
        for name, data in files.items():
            self.assertNotIn(b'/FontFile', data, name)
            self.assertNotIn(b'PRIVATE_SCRIPT_', data, name)

    def test_corrupt_fixtures_cannot_be_mistaken_for_complete_pdfs(self):
        files = fixtures.fixtures()
        self.assertNotIn(b'startxref', files['malformed.pdf'])
        self.assertNotIn(b'%PDF-', files['not-a-pdf.pdf'])


if __name__ == '__main__':
    unittest.main()
