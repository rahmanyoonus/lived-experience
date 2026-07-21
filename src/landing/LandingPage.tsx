import { useEffect, useRef, type PropsWithChildren } from "react";

import heroStoryteller from "./assets/hero-storyteller.webp";
import voiceStoryteller from "./assets/voice-storyteller.webp";
import writingStoryteller from "./assets/writing-storyteller.webp";

export interface LandingPageProps {
  readonly captureHref?: string;
}

function Reveal({
  children,
  className = "",
}: PropsWithChildren<{ className?: string }>) {
  const elementRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }

    const reduceMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduceMotion || !("IntersectionObserver" in window)) {
      element.dataset.revealed = "true";
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          element.dataset.revealed = "true";
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -12%", threshold: 0.12 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={`landing-reveal ${className}`.trim()} ref={elementRef}>
      {children}
    </div>
  );
}

function ArrowMark() {
  return (
    <span aria-hidden="true" className="landing-action__mark">
      →
    </span>
  );
}

export function LandingPage({ captureHref }: LandingPageProps) {
  return (
    <div className="landing-page" id="top">
      <a className="landing-skip-link" href="#landing-main">
        Skip to content
      </a>

      <header className="landing-header">
        <div className="landing-header__inner">
          <a aria-label="Lived Experience home" className="landing-wordmark" href="#top">
            Lived Experience
          </a>
          <nav aria-label="Landing page" className="landing-nav">
            <a href="#how-it-works">How it works</a>
            <a href="#trust">Why it stays yours</a>
            {captureHref ? (
              <a className="landing-nav__action" href={captureHref}>
                Begin a story
              </a>
            ) : null}
          </nav>
        </div>
      </header>

      <main id="landing-main">
        <section aria-labelledby="landing-hero-title" className="landing-hero">
          <div className="landing-hero__copy">
            <p className="landing-eyebrow">Private by default</p>
            <h1 id="landing-hero-title">Your life. Your words.</h1>
            <p className="landing-hero__lede">
              Speak or write at your own pace. Your original words and recording
              stay recoverable.
            </p>
            <a className="landing-action" href="#how-it-works">
              <span>See how it works</span>
              <ArrowMark />
            </a>
          </div>

          <div className="landing-hero__visual" aria-hidden="true">
            <div className="landing-image-shell landing-image-shell--hero">
              <div className="landing-image-core">
                <img
                  alt=""
                  fetchPriority="high"
                  height="1024"
                  src={heroStoryteller}
                  width="1536"
                />
              </div>
            </div>
            <p className="landing-hero__line">
              Stories begin at every age.
            </p>
          </div>
        </section>

        <section aria-labelledby="north-star-title" className="landing-north-star">
          <Reveal>
            <p className="landing-north-star__label">The guiding idea</p>
            <h2 id="north-star-title">Capture first. Make sense of it later.</h2>
            <p>
              No forms, titles or tidy categories stand between you and the
              memory that arrived.
            </p>
          </Reveal>
        </section>

        <section
          aria-labelledby="how-it-works-title"
          className="landing-how"
          id="how-it-works"
        >
          <Reveal className="landing-how__heading">
            <h2 id="how-it-works-title">
              Begin before you have everything figured out.
            </h2>
            <p>
              The canvas opens ready for a memory, not an account form or a set
              of instructions.
            </p>
          </Reveal>

          <div className="landing-how__layout">
            <Reveal className="landing-image-shell landing-image-shell--writing">
              <div className="landing-image-core">
                <img
                  alt="A young woman writing a personal memory on her laptop at home."
                  height="1086"
                  loading="lazy"
                  src={writingStoryteller}
                  width="1448"
                />
              </div>
            </Reveal>

            <div className="landing-how__steps">
              <Reveal className="landing-process">
                <div>
                  <h3>Arrive and begin</h3>
                  <p>
                    Type immediately or choose the microphone. Nothing is
                    created until you start.
                  </p>
                </div>
              </Reveal>
              <Reveal className="landing-process">
                <div>
                  <h3>Speak or write</h3>
                  <p>
                    Pause, change direction or continue later. Silence never
                    decides that you are finished.
                  </p>
                </div>
              </Reveal>
              <Reveal className="landing-process">
                <div>
                  <h3>Keep the original</h3>
                  <p>
                    Edit the readable transcript while the original recording
                    and first transcript remain recoverable.
                  </p>
                </div>
              </Reveal>
            </div>
          </div>
        </section>

        <section aria-labelledby="voice-title" className="landing-voice">
          <div className="landing-voice__layout">
            <Reveal className="landing-voice__copy">
              <h2 id="voice-title">Edit the story. Keep where it came from.</h2>
              <p>
                Transcripts appear only after you stop recording. Refine the
                text without losing the voice behind it.
              </p>
              <blockquote>
                <p>“Faithful does not mean polished. It means recognisably yours.”</p>
              </blockquote>
            </Reveal>

            <Reveal className="landing-image-shell landing-image-shell--voice">
              <div className="landing-image-core">
                <img
                  alt="An older man in his eighties speaking thoughtfully at his kitchen table."
                  height="1402"
                  loading="lazy"
                  src={voiceStoryteller}
                  width="1122"
                />
              </div>
            </Reveal>
          </div>
        </section>

        <section aria-labelledby="trust-title" className="landing-trust" id="trust">
          <Reveal className="landing-trust__statement">
            <h2 id="trust-title">Trust is part of the product.</h2>
            <p>
              Your story is private by default, saved truthfully and guided only
              when you ask.
            </p>
          </Reveal>

          <div className="landing-trust__layout">
            <Reveal className="landing-trust__anchor">
              <p>Your words remain yours.</p>
              <span>
                No public profile, publishing surface or discovery feed sits
                behind the capture page.
              </span>
            </Reveal>

            <div className="landing-trust__principles">
              <Reveal className="landing-principle">
                <h3>Private by default</h3>
                <p>Stories have no public URL or sharing surface.</p>
              </Reveal>
              <Reveal className="landing-principle">
                <h3>Saved truthfully</h3>
                <p>You see whether work is on this device or in your account.</p>
              </Reveal>
              <Reveal className="landing-principle">
                <h3>AI by invitation</h3>
                <p>Just listen stays the default. Guidance remains optional.</p>
              </Reveal>
              <Reveal className="landing-principle">
                <h3>No completion pressure</h3>
                <p>A story may pause, wander or remain unfinished.</p>
              </Reveal>
            </div>
          </div>
        </section>

        <section aria-labelledby="landing-close-title" className="landing-close">
          <Reveal>
            <h2 id="landing-close-title">
              Some memories arrive softly. Give them room to unfold.
            </h2>
            <p>
              Begin with a sentence, a voice note or the part you remember
              clearly.
            </p>
            {captureHref ? (
              <a className="landing-action landing-action--light" href={captureHref}>
                <span>Begin a story</span>
                <ArrowMark />
              </a>
            ) : null}
          </Reveal>
        </section>
      </main>

      <footer className="landing-footer">
        <p className="landing-footer__wordmark">Lived Experience</p>
        <p>Capture first. Make sense of it later.</p>
      </footer>
    </div>
  );
}
