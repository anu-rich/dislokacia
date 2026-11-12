#!/usr/bin/env python3
"""
Checks the Excel export in a real spreadsheet program.

LibreOffice Calc opens random voyages exported by Stalia, recalculates them, and then edits them the way the other
side might: changes the laytime allowed, inserts a row and copies the formulas into it, makes a period not count.
After every step the totals in the sheet are compared with what the calculation engine gives for the same change.

Needs LibreOffice with its Python bridge (python3-uno) and Node.  Run:  python3 tools/check-export.py [count]
"""
import glob, json, os, re, subprocess, sys, tempfile, time

try:
    import uno
    from com.sun.star.beans import PropertyValue
    from com.sun.star.table import CellAddress, CellRangeAddress
except ImportError:
    sys.exit('LibreOffice Python bridge (python3-uno) is not installed — nothing checked.')

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 2019
work = tempfile.mkdtemp(prefix='stalia-export-')
count = sys.argv[1] if len(sys.argv) > 1 else '24'
print(subprocess.check_output(['node', os.path.join(HERE, 'export-fixtures.js'), work, count], text=True).strip())

office = subprocess.Popen(['soffice', '--headless', '--invisible', '--norestore', '--nologo',
                           '-env:UserInstallation=file://' + os.path.join(work, 'profile'),
                           '--accept=socket,host=127.0.0.1,port=%d;urp;' % PORT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
ctx = None
for _ in range(90):
    try:
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
        ctx = resolver.resolve('uno:socket,host=127.0.0.1,port=%d;urp;StarOffice.ComponentContext' % PORT)
        break
    except Exception:
        time.sleep(1)
if ctx is None:
    office.kill()
    sys.exit('LibreOffice did not start.')
desktop = ctx.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', ctx)


def load(path):
    hidden = PropertyValue()
    hidden.Name, hidden.Value = 'Hidden', True
    return desktop.loadComponentFromURL('file://' + os.path.abspath(path), '_blank', 0, (hidden,))


def cell(sheet, ref, moved_from=None):
    """The cell `ref` named when the file was written; rows from `moved_from` (1-based) on have moved one down."""
    m = re.match(r'^([A-Z]+)(\d+)$', ref)
    col = 0
    for ch in m.group(1):
        col = col * 26 + ord(ch) - 64
    row = int(m.group(2))
    if moved_from is not None and row >= moved_from:
        row += 1
    return sheet.getCellByPosition(col - 1, row - 1)


def read(sheet, refs, moved_from=None):
    total, out = refs['total'], {}
    for key in ('allowed', 'used', 'dem', 'des', 'demurrage', 'commission', 'amount'):
        c = cell(sheet, total[key], moved_from)
        if c.getError():
            raise Exception('error %d in %s' % (c.getError(), total[key]))
        out[key] = c.getValue()
    out['despatch'] = cell(sheet, total['despatch'], moved_from).getValue() if 'despatch' in total else 0
    out['ports'] = [{'counted': cell(sheet, p['counted'], moved_from).getValue(), 'dem': cell(sheet, p['dem'], moved_from).getValue()}
                    for p in refs['ports']]
    return out


bad, checks = [], 0


def compare(tag, got, want):
    global checks
    pairs = [(k, got[k], want[k], 1e-8) for k in ('allowed', 'used', 'dem', 'des')]
    pairs += [(k, got[k], want[k], 0.006) for k in ('demurrage', 'commission', 'despatch', 'amount')]
    for i, p in enumerate(want['ports']):
        pairs += [('port %d %s' % (i + 1, k), got['ports'][i][k], p[k], 1e-8) for k in ('counted', 'dem')]
    for name, a, b, tol in pairs:
        checks += 1
        if abs(a - b) > tol:
            bad.append((tag, name, a, b))


files = sorted(glob.glob(os.path.join(work, '*.xlsx')), key=lambda p: int(os.path.basename(p)[:-5]))
try:
    for path in files:
        job = json.load(open(path[:-5] + '.json'))
        tag = os.path.basename(path) + ' (' + job['kind'] + ')'
        doc = load(path)
        sheet = doc.Sheets.getByIndex(0)
        doc.calculateAll()
        compare(tag + ' as exported', read(sheet, job['refs']), job['asIs'])
        for e in job['edits']:
            if e['name'] == 'allowance':
                for ref, value in e['set']:
                    cell(sheet, ref).setValue(value)
                doc.calculateAll()
                compare(tag + ' laytime allowed edited', read(sheet, job['refs']), e['expect'])
        doc.close(True)
        for e in job['edits']:
            if e['name'] not in ('insert', 'top'):
                continue
            doc = load(path)
            sheet = doc.Sheets.getByIndex(0)
            row = e['row']  # 1-based
            if e['name'] == 'insert':  # a new row right below `row`, formulas copied from the row above
                sheet.Rows.insertByIndex(row, 1)
                sheet.copyRange(CellAddress(0, 0, row), CellRangeAddress(0, 0, row - 1, 12, row - 1))
                end = sheet.getCellByPosition(3, row - 1).getValue()
                sheet.getCellByPosition(3, row - 1).setValue(e['at'])
                sheet.getCellByPosition(2, row).setValue(e['at'])
                sheet.getCellByPosition(3, row).setValue(end)
                doc.calculateAll()
                compare(tag + ' row inserted', read(sheet, job['refs'], row + 1), e['pure'])
                sheet.getCellByPosition(6, row).setValue(0)
                sheet.getCellByPosition(7, row).setValue(0)
                doc.calculateAll()
                compare(tag + ' inserted row does not count', read(sheet, job['refs'], row + 1), e['expect'])
            else:  # a new row above the first period, formulas copied from the row below
                sheet.Rows.insertByIndex(row - 1, 1)
                sheet.copyRange(CellAddress(0, 0, row - 1), CellRangeAddress(0, 0, row, 12, row))
                sheet.getCellByPosition(3, row - 1).setValue(e['at'])
                sheet.getCellByPosition(2, row).setValue(e['at'])
                doc.calculateAll()
                compare(tag + ' row inserted at the top', read(sheet, job['refs'], row), e['pure'])
            doc.close(True)
finally:
    try:
        desktop.terminate()
    except Exception:
        pass
    try:
        office.wait(timeout=30)
    except Exception:
        office.kill()

print('workbooks %d, comparisons %d, mismatches %d' % (len(files), checks, len(bad)))
for b in bad[:30]:
    print('  ', b)
sys.exit(1 if bad or not files else 0)
