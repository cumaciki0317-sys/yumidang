"""복구 archive 경로/링크/중복/변조 검증. Docker/DB 실행 없음."""
import hashlib,io,sys,tarfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'integration/minkyu'))
from product_connection_restore108_local import safe_storage_files

def archive(entries):
    output=io.BytesIO()
    with tarfile.open(fileobj=output,mode='w')as tar:
        for name,kind,data in entries:
            info=tarfile.TarInfo(name);info.type=kind
            if kind==tarfile.REGTYPE:info.size=len(data);tar.addfile(info,io.BytesIO(data))
            else:info.linkname='../../outside';tar.addfile(info)
    return output.getvalue()
class ArchiveProtection(unittest.TestCase):
    def test_regular_file_hash_is_exact_and_changes_on_tamper(self):
        value=safe_storage_files(archive([('./bucket/object',tarfile.REGTYPE,b'fixture')]))
        self.assertEqual(value,{'bucket/object':hashlib.sha256(b'fixture').hexdigest()})
        self.assertNotEqual(value,safe_storage_files(archive([('./bucket/object',tarfile.REGTYPE,b'tampered')])))
    def test_traversal_absolute_symlink_hardlink_fifo_and_duplicates_are_rejected(self):
        for entries in [
            [('../outside',tarfile.REGTYPE,b'fixture')], [('/absolute',tarfile.REGTYPE,b'fixture')],
            [('link',tarfile.SYMTYPE,b'')], [('link',tarfile.LNKTYPE,b'')], [('fifo',tarfile.FIFOTYPE,b'')],
            [('bucket/object',tarfile.REGTYPE,b'fixture'),('./bucket/object',tarfile.REGTYPE,b'fixture')],
        ]:
            with self.assertRaises(AssertionError):safe_storage_files(archive(entries))
if __name__=='__main__':unittest.main()
