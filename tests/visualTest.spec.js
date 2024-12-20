const { test } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const sharp = require("sharp");
const config = require("../config.js");

let pixelmatch;
let chalk;

// Dynamically load `pixelmatch` and `chalk`
(async () => {
  pixelmatch = (await import("pixelmatch")).default;
  chalk = (await import("chalk")).default;
})();

// Helper Functions

// Ensure directory exists
function ensureDirectoryExistence(filePath) {
  const dirname = path.dirname(filePath);
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, { recursive: true });
  }
}

// Resize images to match specified dimensions (1280x800)
async function resizeImage(imagePath, width, height) {
  const buffer = fs.readFileSync(imagePath);
  const resizedBuffer = await sharp(buffer)
    .resize(width, height, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .toBuffer();
  fs.writeFileSync(imagePath, resizedBuffer);
}

// Compare two screenshots and return similarity percentage
async function compareScreenshots(baselinePath, currentPath, diffPath) {
  await resizeImage(baselinePath, 1280, 800);
  await resizeImage(currentPath, 1280, 800);

  const img1 = PNG.sync.read(fs.readFileSync(baselinePath));
  const img2 = PNG.sync.read(fs.readFileSync(currentPath));

  if (img1.width !== img2.width || img1.height !== img2.height) {
    console.log(
      chalk.red(`Size mismatch for ${baselinePath} and ${currentPath}`)
    );
    return "Size mismatch";
  }

  const diff = new PNG({ width: img1.width, height: img1.height });
  const mismatchedPixels = pixelmatch(
    img1.data,
    img2.data,
    diff.data,
    img1.width,
    img1.height,
    { threshold: 0.1 }
  );
  fs.writeFileSync(diffPath, PNG.sync.write(diff));

  const totalPixels = img1.width * img1.height;
  const matchedPixels = totalPixels - mismatchedPixels;
  return (matchedPixels / totalPixels) * 100;
}

// Capture screenshot for a given URL, handle timeout and force screenshot
async function captureScreenshot(page, url, screenshotPath) {
  const timeout = 5000; // 5 seconds timeout to detect stuck pages
  let isStuck = false;

  try {
    const navigationPromise = page.goto(url, { waitUntil: "networkidle" });

    // Set a timeout to detect if the page is stuck
    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => {
        isStuck = true;
        resolve();
      }, timeout)
    );

    await Promise.race([navigationPromise, timeoutPromise]);

    if (isStuck) {
      console.log(
        chalk.red(
          `Timeout detected on ${url}. Forcing screenshot and continuing the test.`
        )
      );
    }

    ensureDirectoryExistence(screenshotPath);
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch (error) {
    console.error(`Failed to capture screenshot for ${url}:`, error);
  }
}

// Log result for each page in real-time
function logPageResult(pagePath, similarity, error = null) {
  if (error) {
    console.log(chalk.red(`[Error] Page: ${pagePath} - ${error}`));
  } else if (typeof similarity === "number") {
    const status = similarity >= 95 ? chalk.green("Pass") : chalk.red("Fail");
    console.log(
      `${status} Page: ${pagePath} - Similarity: ${similarity.toFixed(2)}%`
    );
  } else {
    console.log(
      chalk.yellow(`[Unknown] Page: ${pagePath} - ${similarity || "Unknown"}`)
    );
  }
}

// Generate HTML report
function generateHtmlReport(results, deviceName) {
  const reportPath = `visual_comparison_report_${deviceName}.html`;
  let htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Visual Comparison Report - ${deviceName}</title>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.5; margin: 20px; }
        h1, h2 { text-align: center; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 8px; border: 1px solid #ddd; text-align: center; }
        th { background-color: #f2f2f2; }
        .pass { color: green; font-weight: bold; }
        .fail { color: red; font-weight: bold; }
        .error { color: orange; font-weight: bold; }
        img { max-width: 150px; max-height: 100px; }
        a { text-decoration: none; color: inherit; }
        .summary { text-align: center; margin: 20px 0; font-size: 1.1em; }
      </style>
    </head>
    <body>
      <h1>Visual Comparison Report</h1>
      <h2>Device: ${deviceName}</h2>
      <div class="summary">
        <p>Total Pages Tested: ${results.length}</p>
        <p>Passed: ${
          results.filter((r) => r.similarityPercentage >= 95).length
        }</p>
        <p>Failed: ${
          results.filter(
            (r) =>
              r.similarityPercentage < 95 && r.similarityPercentage !== "Error"
          ).length
        }</p>
        <p>Errors: ${
          results.filter((r) => r.similarityPercentage === "Error").length
        }</p>
      </div>
      <table>
        <thead>
          <tr>
            <th>Page</th>
            <th>Similarity</th>
            <th>Status</th>
            <th>Diff Image</th>
          </tr>
        </thead>
        <tbody>
  `;

  results.forEach((result) => {
    const diffThumbnailPath = `screenshots/${deviceName}/diff/${result.pagePath.replace(
      /\//g,
      "_"
    )}.png`;

    const statusClass =
      result.similarityPercentage === "Error"
        ? "error"
        : result.similarityPercentage >= 95
        ? "pass"
        : "fail";

    htmlContent += `
      <tr>
        <td>${result.pagePath}</td>
        <td>${
          typeof result.similarityPercentage === "number"
            ? result.similarityPercentage.toFixed(2) + "%"
            : result.similarityPercentage
        }</td>
        <td class="${statusClass}">${
      result.similarityPercentage === "Error"
        ? "Error"
        : result.similarityPercentage >= 95
        ? "Pass"
        : "Fail"
    }</td>
        <td>${
          fs.existsSync(diffThumbnailPath)
            ? `<a href="${diffThumbnailPath}" target="_blank">
                 <img src="${diffThumbnailPath}" alt="Diff Image">
               </a>`
            : "N/A"
        }</td>
      </tr>
    `;
  });

  htmlContent += `
        </tbody>
      </table>
    </body>
    </html>
  `;

  fs.writeFileSync(reportPath, htmlContent);
  console.log(chalk.green(`HTML report generated: ${reportPath}`));
}

// Main Playwright Test Suite
test.describe("Visual Comparison Tests", () => {
  test.setTimeout(7200000); // Set test timeout to 2 hours

  test("Compare staging and prod screenshots and generate HTML report", async ({
    browser,
  }) => {
    const results = [];
    const deviceName = "Desktop";

    console.log(chalk.blue(`\nRunning visual tests for ${deviceName}`));

    const baseDir = `screenshots/${deviceName}`;
    ["staging", "prod", "diff"].forEach((dir) => {
      const fullPath = path.join(baseDir, dir);
      if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    for (const pagePath of config.staging.urls) {
      const stagingUrl = `${config.staging.baseUrl}${pagePath}`;
      const prodUrl = `${config.prod.baseUrl}${pagePath}`;
      const stagingScreenshotPath = path.join(
        baseDir,
        "staging",
        `${pagePath.replace(/\//g, "_")}.png`
      );
      const prodScreenshotPath = path.join(
        baseDir,
        "prod",
        `${pagePath.replace(/\//g, "_")}.png`
      );
      const diffScreenshotPath = path.join(
        baseDir,
        "diff",
        `${pagePath.replace(/\//g, "_")}.png`
      );

      try {
        console.log(chalk.yellow(`\nTesting page: ${pagePath}`));

        await captureScreenshot(page, stagingUrl, stagingScreenshotPath);
        await captureScreenshot(page, prodUrl, prodScreenshotPath);

        const similarity = await compareScreenshots(
          stagingScreenshotPath,
          prodScreenshotPath,
          diffScreenshotPath
        );

        logPageResult(pagePath, similarity);
        results.push({
          pagePath,
          similarityPercentage: similarity,
        });
      } catch (error) {
        logPageResult(pagePath, null, error.message);
        results.push({
          pagePath,
          similarityPercentage: "Error",
          error: error.message,
        });
      }
    }

    generateHtmlReport(results, deviceName);
    await context.close();
  });
});
