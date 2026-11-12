/** One card: a heading, an optional line of explanation, and its controls. */
export function Block({
  title,
  note,
  aside,
  children,
}: {
  title: string;
  note?: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="block">
      <div className="block-head">
        <div>
          <h2>{title}</h2>
          {note && <p className="block-note">{note}</p>}
        </div>
        {aside}
      </div>
      <div className="block-body">{children}</div>
    </section>
  );
}
