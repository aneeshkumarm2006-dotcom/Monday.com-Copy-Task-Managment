/* Throwaway harness — renders FilePreviewModal against fixtures. Delete after use. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { jsPDF } from 'jspdf';
import './index.css';
import FilePreviewModal from './components/board/FilePreviewModal';
import AttachmentList from './components/board/AttachmentList';

// 1x1 red png, enough to prove the image branch renders and zooms.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABGCAYAAABn+m+8AAAAWklEQVR4nO3QMQEAAAjAoNm/9BJ4gwR2tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgH8DYuwAAV6cVjEAAAAASUVORK5CYII=';

const pdf = new jsPDF();
pdf.setFontSize(18);
pdf.text('Client brief — March campaign', 20, 30);
pdf.setFontSize(11);
pdf.text('This PDF is rendered inside the modal, not downloaded.', 20, 45);
const PDF_BLOB = pdf.output('blob');

const TEXT_BLOB = new Blob(
  ['keyword,volume,position\nbest crm for agencies,2400,7\nagency crm,880,3\n'],
  { type: 'text/csv' }
);

// Stand in for the authenticated proxy.
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.includes('/api/proxy/download')) {
    const body = url.includes('.csv') ? TEXT_BLOB : PDF_BLOB;
    return new Response(body, { status: 200 });
  }
  return realFetch(input, init);
};

const FIXTURES = [
  { _id: '1', url: PNG, name: 'homepage-screenshot.png', mime: 'image/png', size: 184320 },
  {
    _id: '2',
    url: 'https://res.cloudinary.com/demo/raw/upload/brief.pdf',
    name: 'march-brief.pdf',
    mime: 'application/pdf',
    size: 421000,
  },
  {
    _id: '3',
    url: 'https://res.cloudinary.com/demo/raw/upload/ranks.csv',
    name: 'ranks.csv',
    mime: 'text/csv',
    size: 2100,
  },
  {
    _id: '4',
    url: 'https://res.cloudinary.com/demo/raw/upload/report.docx',
    name: 'quarterly-report.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 90400,
  },
];

const Harness = () => {
  const [index, setIndex] = useState(null);
  return (
    <div style={{ padding: 24, maxWidth: 620, fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 16 }}>Update attachments</h1>
      <AttachmentList attachments={FIXTURES} />
      <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
        {FIXTURES.map((f, i) => (
          <button key={f._id} id={`open-${i}`} type="button" onClick={() => setIndex(i)}>
            open {f.name}
          </button>
        ))}
      </div>
      {index !== null && (
        <FilePreviewModal
          attachments={FIXTURES}
          index={index}
          onIndexChange={setIndex}
          onClose={() => setIndex(null)}
        />
      )}
    </div>
  );
};

createRoot(document.getElementById('root')).render(<Harness />);
