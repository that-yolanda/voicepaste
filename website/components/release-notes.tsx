import Markdown from "react-markdown"

export function ReleaseNotes({ children }: { children: string }) {
  return (
    <div className="release-notes max-w-prose text-base leading-7 text-muted-foreground [&_a]:underline [&_a]:underline-offset-4 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:text-sm [&_li]:mt-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mt-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-4 [&_strong]:font-semibold [&_strong]:text-foreground [&_ul]:list-disc [&_ul]:pl-5 [&>:first-child]:mt-0 [&>h4]:mt-8 [&>h4]:text-base [&>h4]:font-semibold [&>h4]:tracking-normal [&>h4]:text-foreground">
      <Markdown skipHtml components={{ h1: "h4", h2: "h4", h3: "h4" }}>
        {children}
      </Markdown>
    </div>
  )
}
