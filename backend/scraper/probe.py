"""Quick probe: what does the RBI Master Directions index give us?"""
import asyncio, re, json
from crawl4ai import AsyncWebCrawler

URL = "https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx"

async def main():
    async with AsyncWebCrawler() as crawler:
        r = await crawler.arun(url=URL)
        print("status:", r.status_code, "| html len:", len(r.html or ""))
        links = (r.links or {}).get("internal", []) + (r.links or {}).get("external", [])
        pdfs = [l for l in links if ".pdf" in (l.get("href") or "").lower()]
        details = [l for l in links if "ViewMasDirections.aspx?id=" in (l.get("href") or "")]
        print("total links:", len(links), "| pdf links:", len(pdfs), "| detail links:", len(details))
        for l in pdfs[:5]:
            print("PDF:", json.dumps({"href": l.get("href"), "text": (l.get("text") or "")[:90]}))
        for l in details[:5]:
            print("DET:", json.dumps({"href": l.get("href"), "text": (l.get("text") or "")[:90]}))
        # table rows in raw html?
        rows = re.findall(r"<tr.*?</tr>", r.html or "", re.S)
        print("tr count:", len(rows))

asyncio.run(main())
