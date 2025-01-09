import Queue from "p-queue"
import { Window } from "happy-dom"
import { Readability } from "@mozilla/readability"
import { encode } from "gpt-tokenizer/model/gpt-4o"
import { toMarkdown } from "./to-markdown"
import { logger } from "./logger"
import { load } from "cheerio"

type Page = {
  title: string
  url: string
  content: string
  tokenCount: number
}

export async function fetchSite(url: string, options: { concurrency: number }) {
  const queue = new Queue({ concurrency: options.concurrency })

  const pages: Map<string, Page> = new Map()
  const fetched: Set<string> = new Set()

  await fetchPage(url, { pages, fetched, queue })

  await queue.onIdle()

  return pages
}

export async function fetchPage(
  url: string,
  options: { pages: Map<string, Page>; fetched: Set<string>; queue: Queue }
) {
  const { queue, pages, fetched } = options

  const { host, pathname } = new URL(url)

  if (fetched.has(pathname)) {
    return
  }

  logger.info(`Fetching ${url}`)

  fetched.add(pathname)

  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  })

  if (!res.ok) {
    logger.warn(`Failed to fetch ${url}: ${res.statusText}`)
    return
  }

  const contentType = res.headers.get("content-type")

  if (!contentType?.includes("text/html")) {
    logger.warn(`Not a HTML page: ${url}`)
    return
  }

  const resUrl = new URL(res.url)

  // redirected to other site, ignore
  if (resUrl.host !== host) {
    logger.warn(`Redirected to other site: ${url}`)
    return
  }
  const extraUrls: string[] = []

  const $ = load(await res.text())
  $("script,style,link").remove()

  const html = $.html()

  const window = new Window({
    url,
    console: console,
  })

  window.document.write(html)

  await window.happyDOM.waitUntilComplete()

  window.document.querySelectorAll("a").forEach((link) => {
    const href = link.getAttribute("href")

    if (!href) {
      return
    }

    const thisUrl = new URL(href, url)
    if (thisUrl.host !== host) {
      return
    }

    extraUrls.push(thisUrl.href)
  })

  const article = new Readability(window.document as any).parse()

  await window.happyDOM.close()

  if (extraUrls.length > 0) {
    for (const url of extraUrls) {
      queue.add(() => fetchPage(url, options))
    }
  }

  if (!article) {
    return
  }

  const content = toMarkdown(article.content)

  const tokenCount = encode(content).length

  pages.set(pathname, {
    title: article.title,
    url,
    content,
    tokenCount,
  })
}

export function serializePages(
  pages: Map<string, Page>,
  format: "json" | "text"
) {
  if (format === "json") {
    return JSON.stringify([...pages.values()])
  }

  return [...pages.values()]
    .map((page) =>
      `<page>
  <title>${page.title}</title>
  <url>${page.url}</url>
  <content>${page.content}</content>
</page>`.trim()
    )
    .join("\n\n")
}
