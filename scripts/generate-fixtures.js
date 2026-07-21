'use strict';

/**
 * WINE AI KOS - Fixture Generator (Step 2B Production)
 *
 * Generates valid binary PDF fixture (`tests/fixtures/sample.pdf`) with embedded Unicode font (Cyrillic + Romanian diacritics)
 * and expanded OpenXML DOCX fixture (`tests/fixtures/sample.docx`) with document.xml, styles.xml, numbering.xml, footnotes.xml, endnotes.xml, _rels/document.xml.rels.
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const FIXTURES_DIR = path.resolve(__dirname, '../tests/fixtures');
if (!fs.existsSync(FIXTURES_DIR)) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
}

function createSampleDocx() {
    const zip = new AdmZip();

    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
    <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
    <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
    <Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>
</Types>`;

    const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

    const documentRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
    <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
    <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
    <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>
    <Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/winery" TargetMode="External"/>
</Relationships>`;

    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:style w:type="paragraph" w:styleId="Heading1">
        <w:name w:val="heading 1"/>
    </w:style>
</w:styles>`;

    const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:abstractNum w:abstractNumId="0">
        <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
    </w:abstractNum>
    <w:abstractNum w:abstractNumId="1">
        <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl>
    </w:abstractNum>
    <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
    <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

    const footnotesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:footnote w:id="1"><w:p><w:r><w:t>Notă de subsol: Purcari fondat în 1827.</w:t></w:r></w:p></w:footnote>
</w:footnotes>`;

    const endnotesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:endnote w:id="1"><w:p><w:r><w:t>Notă finală despre regiunea Ștefan Vodă.</w:t></w:r></w:p></w:endnote>
</w:endnotes>`;

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
    <w:body>
        <w:p>
            <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
            <w:r><w:t>Castel Mimi — Pașaport Tehnologic</w:t></w:r>
        </w:p>
        <w:p>
            <w:r><w:t>Винодельня Молдовы Castel Mimi основана Константином Мими.</w:t></w:r>
        </w:p>
        <w:p>
            <w:pPr><w:numPr><w:numId w:val="1"/><w:ilvl w:val="0"/></w:numPr></w:pPr>
            <w:r><w:t>Soiul Fetească Neagră — Țara Moldovei, Ștefan cel Mare.</w:t></w:r>
        </w:p>
        <w:p>
            <w:pPr><w:numPr><w:numId w:val="2"/><w:ilvl w:val="0"/></w:numPr></w:pPr>
            <w:r><w:t>Colecția Governor 2019</w:t></w:r>
        </w:p>
        <w:p>
            <w:hyperlink r:id="rId6">
                <w:r><w:t>Site oficial Castel Mimi</w:t></w:r>
            </w:hyperlink>
        </w:p>
        <w:tbl>
            <w:tr>
                <w:tc><w:p><w:r><w:t>Colecție</w:t></w:r></w:p></w:tc>
                <w:tc><w:p><w:r><w:t>An</w:t></w:r></w:p></w:tc>
            </w:tr>
            <w:tr>
                <w:tc><w:p><w:r><w:t>Governor</w:t></w:r></w:p></w:tc>
                <w:tc><w:p><w:r><w:t>2019</w:t></w:r></w:p></w:tc>
            </w:tr>
        </w:tbl>
    </w:body>
</w:document>`;

    zip.addFile('[Content_Types].xml', Buffer.from(contentTypesXml, 'utf8'));
    zip.addFile('_rels/.rels', Buffer.from(relsXml, 'utf8'));
    zip.addFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
    zip.addFile('word/_rels/document.xml.rels', Buffer.from(documentRelsXml, 'utf8'));
    zip.addFile('word/styles.xml', Buffer.from(stylesXml, 'utf8'));
    zip.addFile('word/numbering.xml', Buffer.from(numberingXml, 'utf8'));
    zip.addFile('word/footnotes.xml', Buffer.from(footnotesXml, 'utf8'));
    zip.addFile('word/endnotes.xml', Buffer.from(endnotesXml, 'utf8'));

    const docxBuffer = zip.toBuffer();
    fs.writeFileSync(path.join(FIXTURES_DIR, 'sample.docx'), docxBuffer);
    console.log('Generated expanded OpenXML DOCX fixture: tests/fixtures/sample.docx');
}

async function createSamplePdf() {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);

    const fontPath = process.env.FONT_PATH || 'C:\\Windows\\Fonts\\arial.ttf';
    if (!fs.existsSync(fontPath)) {
        throw new Error(`Font file not found at ${fontPath}`);
    }

    const fontBuffer = fs.readFileSync(fontPath);
    const customFont = await pdfDoc.embedFont(fontBuffer);

    const page1 = pdfDoc.addPage([612, 792]);
    page1.drawText('Castel Mimi Governor 2019 - Fetească Neagră - Ștefan cel Mare', {
        x: 50,
        y: 700,
        size: 14,
        font: customFont,
        color: rgb(0, 0, 0),
    });

    const page2 = pdfDoc.addPage([612, 792]);
    page2.drawText('винодельня Молдовы - Purcari Rose - Ștefan Vodă Region', {
        x: 50,
        y: 700,
        size: 14,
        font: customFont,
        color: rgb(0, 0, 0),
    });

    const pdfBytes = await pdfDoc.save();
    fs.writeFileSync(path.join(FIXTURES_DIR, 'sample.pdf'), pdfBytes);
    console.log('Generated real valid Unicode PDF fixture: tests/fixtures/sample.pdf');
}

async function main() {
    createSampleDocx();
    await createSamplePdf();
}

main().catch((err) => {
    console.error('Failed to generate fixtures:', err);
    process.exit(1);
});
