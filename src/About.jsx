const sections = [
  {
    title: 'What it is',
    body: (
      <>
        <p>
          Second Order is used by a small group of researchers by invitation. It is not a public service and there
          is no sign-up.
        </p>
        <p>
          There is no researcher web interface. Researchers work through Claude or ChatGPT, which connect to Second
          Order as a custom connector. You describe the experiment you want; the assistant writes it, tests it and
          runs it through Second Order's tools.
        </p>
      </>
    ),
  },
  {
    title: 'How a study runs',
    body: (
      <ol className="about-list">
        <li>The assistant writes the experiment as a jsPsych module, using the lab's standard blocks for consent, device checks, demographics and debrief.</li>
        <li>Simulated participants run through it to check the data before anyone real sees it.</li>
        <li>A dashboard lets you click through the study yourself and check the timeline and the data it produces.</li>
        <li>A launch check confirms the consent and debrief, completion handling and data saving.</li>
        <li>Participants take part through a Prolific, SONA or lab link. Each trial is saved as it finishes.</li>
        <li>Completion, dropouts, data quality and exclusions are reported back in the chat, and data downloads as CSV or JSON.</li>
      </ol>
    ),
  },
  {
    title: 'What it covers',
    body: (
      <ul className="about-list">
        <li>Any jsPsych 8 plugin, with exact package versions recorded for each study.</li>
        <li>Stimulus files (images, audio, video), stored once and shared between studies.</li>
        <li>Condition assignment balanced on the server, per participant link.</li>
        <li>Resuming after a reload, from the last completed part of the experiment.</li>
        <li>Consent and debrief texts kept in a versioned library, so the data records which text each participant saw.</li>
        <li>Recruitment through Prolific (drafts, launch, places) or SONA.</li>
        <li>Experience sampling (ESM / EMA) through the MetaForge phone app.</li>
        <li>Collaborators per study as editor or viewer, and saved versions when you ask for them.</li>
      </ul>
    ),
  },
  {
    title: 'Participants and data',
    body: (
      <p>
        Experiments run on a separate site, run.2ndorder.live, which can only send data back to Second Order.
        Simulated runs happen in an isolated process with no network or database access. Data is stored on a
        server we run, not with a third party, and individual participants' data can be deleted on request.
      </p>
    ),
  },
  {
    title: 'Access',
    body: (
      <p>
        Accounts are by invitation only and sign in with a passkey. If you are working with the lab and need
        access, ask Kit Double for an invite.
      </p>
    ),
  },
  {
    title: 'Running your own',
    body: (
      <p>
        The code is open source under the MIT licence at{' '}
        <a href="https://github.com/kitdouble/second-order">github.com/kitdouble/second-order</a>. The README
        explains how to set up a copy for your own lab, including your own ethics-approved consent and debrief
        texts.
      </p>
    ),
  },
];

export default function About() {
  return (
    <div className="about-container">
      <header className="about-header">
        <a href="/" className="about-brand">
          <img src="/logo.png" alt="" />
          <span>Second Order</span>
        </a>
        <a href="/login" className="text-link">Sign in</a>
      </header>
      <main className="about-main">
        <h1>About</h1>
        <p className="about-lede">
          A lab tool for building and running online behavioural experiments, used through Claude or ChatGPT.
        </p>
        {sections.map(({ title, body }) => (
          <section key={title} className="about-section">
            <h2>{title}</h2>
            {body}
          </section>
        ))}
      </main>
      <footer className="about-footer">
        <p>&copy; {new Date().getFullYear()} Kit Double. All Rights Reserved.</p>
      </footer>
    </div>
  );
}
