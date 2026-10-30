/* Stamp the vinyl icon + version info onto the packaged MEASURED.exe.
   electron-builder's rcedit path is disabled here (winCodeSign cannot extract
   under this sandbox), so we do the same job in pure JS with resedit. */
const fs = require('fs');
const path = require('path');
const ResEdit = require('resedit');

const exePath = process.argv[2] || path.join(__dirname, 'dist', 'win-unpacked', 'MEASURED.exe');
const icoPath = path.join(__dirname, 'icon.ico');
if (!fs.existsSync(exePath)) throw new Error('missing exe: ' + exePath);
if (!fs.existsSync(icoPath)) throw new Error('missing icon.ico — run make-ico.cjs first');

const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(exe);

const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
  res.entries,
  1,
  1033,
  iconFile.icons.map((i) => i.data)
);
console.log('icon groups now:', ResEdit.Resource.IconGroupEntry.fromEntries(res.entries).length);

const viList = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
if (viList.length) {
  const vi = viList[0];
  const lang = 1033;
  vi.setFileVersion(1, 0, 0, 0, lang);
  vi.setProductVersion(1, 0, 0, 0, lang);
  vi.setStringValues({ lang, codepage: 1200 }, {
    CompanyName: 'Ali',
    FileDescription: 'MEASURED — local music library',
    FileVersion: '1.0.0',
    InternalName: 'MEASURED',
    LegalCopyright: 'Ali',
    OriginalFilename: 'MEASURED.exe',
    ProductName: 'MEASURED',
    ProductVersion: '1.0.0',
  });
  vi.outputToResourceEntries(res.entries);
  console.log('version strings stamped');
}

res.outputResource(exe);
const out = Buffer.from(exe.generate());
fs.writeFileSync(exePath, out);
console.log(`patched ${exePath}  ${(out.length / 1048576).toFixed(1)} MB`);
