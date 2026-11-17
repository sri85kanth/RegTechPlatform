"""Probe candidate official regulation indexes across authorities."""
import asyncio, json
from crawl4ai import AsyncWebCrawler

CANDIDATES = [
    ("SEBI regulations", "https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=1&ssid=3&smid=0"),
    ("IndiaCode central acts", "https://www.indiacode.nic.in/handle/123456789/1362/browse?type=shorttitle&sort_by=1&order=ASC&rpp=50&offset=0"),
    ("Labour ministry acts", "https://labour.gov.in/acts"),
    ("MeitY acts", "https://www.meity.gov.in/content/acts"),
    ("IRDAI regulations", "https://irdai.gov.in/consolidated-gazette-notified-regulations"),
    ("CBIC GST acts", "https://cbic-gst.gov.in/gst-acts.html"),
]

async def main():
    async with AsyncWebCrawler() as crawler:
        for name, url in CANDIDATES:
            try:
                r = await asyncio.wait_for(crawler.arun(url=url), timeout=60)
                links = (r.links or {}).get("internal", []) + (r.links or {}).get("external", [])
                pdfs = [l for l in links if ".pdf" in (l.get("href") or "").lower()]
                print(json.dumps({"src": name, "status": r.status_code, "html": len(r.html or ""), "links": len(links), "pdfs": len(pdfs)}))
            except Exception as e:
                print(json.dumps({"src": name, "error": str(e)[:100]}))

asyncio.run(main())
