import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

import type { BrowsedSkill, LocalSkillBrowser } from "./browser.js";
import { Badge } from "./catalyst/badge.js";
import { Button } from "./catalyst/button.js";
import { Heading } from "./catalyst/heading.js";
import { Text } from "./catalyst/text.js";
import { externalLink } from "./external-link.js";

export function SkillBrowser({
  revision,
  onSelect,
}: {
  readonly revision: string;
  readonly onSelect: (catalog: string, name: string) => void;
}) {
  const [listing, setListing] = useState<LocalSkillBrowser | null>(null);
  const [active, setActive] = useState<BrowsedSkill | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let current = true;

    setLoading(true);
    setError(null);
    void window.ambit
      .browseLocalSkills()
      .then(
        (result) => {
          if (current) {
            setListing(result);
          }
        },
        (reason) => {
          if (current) {
            setError(String(reason));
          }
        },
      )
      .finally(() => {
        if (current) {
          setLoading(false);
        }
      });

    return () => {
      current = false;
    };
  }, [revision]);

  async function openSkill(skill: BrowsedSkill): Promise<void> {
    setActive(skill);
    setContent(null);
    setError(null);
    setLoading(true);
    try {
      setContent(await window.ambit.readLocalSkill(skill.catalog, skill.name));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section
      className="mt-6 border-t border-zinc-200 pt-5 dark:border-zinc-700"
      aria-labelledby="skills-title"
    >
      <Heading level={3} id="skills-title">
        Skills
      </Heading>
      <Text>Browse skills in connected local catalogs.</Text>
      {loading && <p role="status">Loading skills…</p>}
      {error && (
        <p role="alert" className="text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
      {listing?.remoteCatalogs.length ? (
        <Text>Remote catalogs are not shown here: {listing.remoteCatalogs.join(", ")}.</Text>
      ) : null}
      {listing?.skills.length === 0 && <Text>No local skills found.</Text>}
      {listing && listing.skills.length > 0 && (
        <ul
          className="mt-3 divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-700 dark:border-zinc-700"
          aria-label="Local skills"
        >
          {listing.skills.map((skill) => (
            <li
              key={`${skill.catalog}/${skill.name}`}
              className="flex items-start justify-between gap-4 px-4 py-3"
            >
              <div className="min-w-0">
                <Button
                  type="button"
                  plain
                  onClick={() => void openSkill(skill)}
                  aria-label={`Read ${skill.catalog}/${skill.name}`}
                >
                  {skill.name}
                </Button>
                <Text className="m-0 break-words text-sm">
                  {skill.catalog}
                  {skill.description ? ` · ${skill.description}` : ""}
                </Text>
              </div>
              <div className="flex items-center gap-2">
                <Badge color={skill.selected ? "green" : "zinc"}>
                  {skill.selected ? "Selected" : "Not selected"}
                </Badge>
                {!skill.selected && skill.dependencyFree && (
                  <Button type="button" onClick={() => onSelect(skill.catalog, skill.name)}>
                    Select
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {active && (
        <section
          className="mt-5 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-900"
          aria-labelledby="skill-preview-title"
        >
          <div className="flex items-start justify-between gap-3">
            <Heading level={3} id="skill-preview-title">
              {active.catalog}/{active.name}
            </Heading>
            <Button
              type="button"
              plain
              onClick={() => {
                setActive(null);
                setContent(null);
              }}
            >
              Close
            </Button>
          </div>
          {content !== null && (
            <div
              className="max-h-96 space-y-3 overflow-auto break-words text-sm [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-400 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-zinc-200 [&_code]:px-1 dark:[&_code]:bg-zinc-700 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-zinc-200 [&_pre]:p-3 dark:[&_pre]:bg-zinc-800"
              aria-label="Skill file contents"
            >
              <Markdown
                skipHtml
                rehypePlugins={[rehypeSanitize]}
                urlTransform={(url) => externalLink(url) ?? ""}
                components={{
                  img: () => null,
                  a: ({ href, children }) => {
                    const url = href ? externalLink(href) : null;

                    return url ? (
                      <a
                        href={url}
                        className="text-blue-700 underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:text-blue-300"
                        onClick={(event) => {
                          event.preventDefault();
                          void window.ambit
                            .openExternal(url)
                            .catch((reason) => setError(String(reason)));
                        }}
                      >
                        {children}
                      </a>
                    ) : (
                      <span>{children}</span>
                    );
                  },
                }}
              >
                {content}
              </Markdown>
            </div>
          )}
        </section>
      )}
    </section>
  );
}
