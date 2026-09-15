import SectionFrame from '../SectionFrame';

/**
 * NoteSection — a reminder somebody typed, on the page where they will see it.
 *
 * Payload (`executiveHome.runNote`): `{ title, text }`, echoed back from the
 * section's own config after the server re-clamped both. No query stands behind
 * it; it is the one section type that is not a window onto data.
 *
 * ---- WHY THIS RENDERS PLAIN TEXT -----------------------------------------
 *
 * The design sketch called this "static rich text", and the shipped shape is a
 * clamped String on a Mixed config field. It is rendered as TEXT, never through
 * `dangerouslySetInnerHTML`, and that is not a shortcut — a note is written by
 * an admin into somebody else's home page and read by the one person in the
 * workspace whose session is worth the most. Markup arriving down that path
 * would be script injection with a configuration form for a delivery
 * mechanism. `white-space: pre-wrap` gives back the only formatting a reminder
 * actually needs, which is the line breaks the author typed.
 *
 * If this ever does want rich text, the answer is the editor the Updates
 * composer already uses plus sanitisation on the way in — not a change to this
 * one line.
 *
 * ---- THE TITLE IS OPTIONAL, AND SO IS THE BODY ---------------------------
 *
 * Either alone is a legitimate note: a heading with nothing under it is a
 * label, and a paragraph with no heading is a sentence. Only both empty is
 * `empty`, which the composer decides, and which on this type means somebody
 * added the section and has not written in it yet — so the message says that
 * rather than pretending there was something to fetch.
 *
 * When the note HAS a title, the frame's heading becomes it, because a card
 * headed "Note" above a heading the author wrote is one heading too many. The
 * generic word is only used when there is nothing better.
 */

const NoteSection = ({ section }) => {
  const data = section?.data || {};
  const title = (data.title || '').trim();

  return (
    <SectionFrame
      section={section}
      title={title || 'Note'}
      emptyMessage="This note is empty."
      // A title with no body is a legitimate note (see above) and its body is
      // therefore nothing at all. Padding around nothing is a 32px strip under
      // the heading that reads as content failing to load, so that one case
      // drops the padding rather than drawing the gap.
      flush={section?.state === 'ok' && !data.text}
    >
      {() =>
        data.text ? (
          <p
            className="font-body"
            style={{
              fontSize: 13.5,
              lineHeight: 'var(--leading-relaxed)',
              color: 'var(--color-text-secondary)',
              // The author's own line breaks, and nothing else. `pre-wrap` also
              // keeps long unbroken strings from pushing the panel wider than
              // its column, which `overflow-wrap` finishes off.
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {data.text}
          </p>
        ) : null
      }
    </SectionFrame>
  );
};

export default NoteSection;
