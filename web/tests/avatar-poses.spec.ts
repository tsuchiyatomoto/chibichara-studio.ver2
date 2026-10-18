import { expect, test, type Page } from "@playwright/test";

type ImageRequest = {
  prompt: string;
  provider?: "vertex" | "openai";
  referenceImage?: string;
  secondaryReferenceImage?: string;
};

function mockImage(index: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="white"/><text y="20">${index}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

async function prepareAvatar(page: Page, failRequestIndex = -1, beforeReply?: (index: number) => Promise<void>) {
  const requests: ImageRequest[] = [];
  await page.route("**/api/generate-image", async (route) => {
    const index = requests.length;
    requests.push(route.request().postDataJSON());
    await beforeReply?.(index);
    await route.fulfill(
      index === failRequestIndex
        ? { status: 500, json: { error: "テスト用の生成エラー" } }
        : { json: { image: mockImage(index), provider: requests[index].provider ?? "vertex" } },
    );
  });
  await page.goto("http://localhost:3000/avatar");
  await page.getByRole("button", { name: "キャラクター生成", exact: true }).click();
  await expect(page.getByRole("img", { name: "生成したキャラクター", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "ポーズ", exact: true }).click();
  return requests;
}

async function selectPose(page: Page, group: number, label: string) {
  await selectPoseGroup(page, group);
  await page.getByRole("button", { name: label, exact: true }).click();
}

async function selectPoseGroup(page: Page, group: number) {
  await page.getByLabel("ポーズ項目", { exact: true })
    .getByRole("button", { name: new RegExp(`^ポーズ${group}`) }).click();
}

async function generateAvatar(page: Page, frameCount: number) {
  await page.getByRole("button", { name: "アバター生成", exact: true }).click();
  await expect(page.getByRole("button", { name: "アバター生成", exact: true })).toBeEnabled();
  await expect(page.locator("#generated-image-panel img")).toHaveCount(frameCount);
}

function visibleAvatar(page: Page) {
  return page.locator('#generated-image-panel img[aria-hidden="false"]');
}

async function expectPoseFrames(page: Page, group: number, firstImage: number) {
  const frames = page.locator(`#generated-image-panel img[alt^="生成したアバター（ポーズ${group}・"]`);
  await expect(frames).toHaveCount(4);
  for (const [frame, offset] of [0, 1, 3, 2].entries()) {
    await expect(frames.nth(frame)).toHaveAttribute("src", mockImage(firstImage + offset));
  }
}

async function freezeClock(page: Page) {
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(new Date(now.getTime() + 1000));
}

async function storedAvatarImages(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("chibichara-avatar", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<{ character: { image: string }; avatarPoses: { id: string; frames: string[] }[] }>((resolve, reject) => {
        const transaction = db.transaction("session", "readonly");
        const request = transaction.objectStore("session").get("images");
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  });
}

async function prepareVoiceNavigation(page: Page) {
  await page.route("**/api/generate-speech", (route) => route.fulfill({ json: {
    connected: true, speakerInversion: { ready: true, min_samples: 5 },
  } }));
}

async function navigateToStudio(page: Page, studio: "Avatar" | "Voice") {
  await page.getByRole("navigation", { name: "制作機能", exact: true })
    .getByRole("link", { name: studio, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${studio.toLowerCase()}$`));
}

test("avatar generation keeps progress and edited settings across page navigation without duplicate requests", async ({ page }) => {
  let finishFrame!: () => void;
  const pendingFrame = new Promise<void>((resolve) => { finishFrame = resolve; });
  const requests = await prepareAvatar(page, -1, async (index) => {
    if (index === 2) await pendingFrame;
  });
  await prepareVoiceNavigation(page);
  await selectPose(page, 2, "両手ピース");
  await selectPose(page, 3, "ガッツポーズ");
  await page.getByRole("button", { name: "アバター生成", exact: true }).click();
  try {
    await expect.poll(() => requests.length).toBe(3);
    await selectPose(page, 3, "サムズアップ");
    await navigateToStudio(page, "Voice");
    await navigateToStudio(page, "Avatar");
    await expect(page.getByRole("status")).toHaveText("ポーズ1を生成しています（2 / 12枚）。");
    await expect(page.getByRole("button", { name: "アバター生成中...", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "サムズアップ", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.locator("main form").dispatchEvent("submit");
    expect(requests).toHaveLength(3);
  } finally {
    finishFrame();
  }
  await expect(page.getByRole("button", { name: "アバター生成", exact: true })).toBeEnabled();
  await expect(page.locator("#generated-image-panel img")).toHaveCount(12);
  expect(requests).toHaveLength(13);
  expect(requests[9].prompt).toContain("a celebratory fist-pump pose");
  await expect(page.getByRole("status")).toHaveText("生成対象：ポーズ3（4枚）。");
});

test("avatar frames completed on another page are visible immediately on return", async ({ page }) => {
  let finishFrame!: () => void;
  const pendingFrame = new Promise<void>((resolve) => { finishFrame = resolve; });
  const requests = await prepareAvatar(page, -1, async (index) => {
    if (index === 1) await pendingFrame;
  });
  await prepareVoiceNavigation(page);
  await page.getByRole("button", { name: "アバター生成", exact: true }).click();
  try {
    await expect.poll(() => requests.length).toBe(2);
    await navigateToStudio(page, "Voice");
  } finally {
    finishFrame();
  }
  await expect.poll(async () => (await storedAvatarImages(page)).avatarPoses.length).toBe(1);
  await navigateToStudio(page, "Avatar");
  await expectPoseFrames(page, 1, 1);
  await expect(page.getByRole("button", { name: "アバター生成", exact: true })).toBeEnabled();
  expect(requests).toHaveLength(5);
});

test("a generation failure on another page keeps completed poses and permits retry on return", async ({ page }) => {
  let finishFrame!: () => void;
  const pendingFrame = new Promise<void>((resolve) => { finishFrame = resolve; });
  const requests = await prepareAvatar(page, 5, async (index) => {
    if (index === 5) await pendingFrame;
  });
  await prepareVoiceNavigation(page);
  await selectPose(page, 2, "両手ピース");
  await page.getByRole("button", { name: "アバター生成", exact: true }).click();
  try {
    await expect.poll(() => requests.length).toBe(6);
    await navigateToStudio(page, "Voice");
  } finally {
    finishFrame();
  }
  await navigateToStudio(page, "Avatar");
  await expect(page.getByText("テスト用の生成エラー", { exact: true })).toBeVisible();
  await expectPoseFrames(page, 1, 1);
  expect(requests).toHaveLength(6);
  await generateAvatar(page, 8);
  await expectPoseFrames(page, 1, 1);
  await expectPoseFrames(page, 2, 6);
  expect(requests).toHaveLength(10);
});

test("character generation also survives leaving and returning to Avatar", async ({ page }) => {
  let finishImage!: () => void;
  const pendingImage = new Promise<void>((resolve) => { finishImage = resolve; });
  let requests = 0;
  await page.route("**/api/generate-image", async (route) => {
    requests++;
    await pendingImage;
    await route.fulfill({ json: { image: mockImage(0), provider: "vertex" } });
  });
  await prepareVoiceNavigation(page);
  await page.goto("/avatar");
  await page.getByRole("button", { name: "キャラクター生成", exact: true }).click();
  try {
    await expect.poll(() => requests).toBe(1);
    await navigateToStudio(page, "Voice");
    await navigateToStudio(page, "Avatar");
    await expect(page.getByRole("button", { name: "キャラクター生成中...", exact: true })).toBeDisabled();
    await expect(page.getByRole("status")).toHaveText("キャラクターを生成しています。");
  } finally {
    finishImage();
  }
  await expect(page.getByRole("img", { name: "生成したキャラクター", exact: true })).toHaveAttribute("src", mockImage(0));
  await expect(page.getByRole("button", { name: "キャラクター生成", exact: true })).toBeEnabled();
  expect(requests).toBe(1);
});

test("background removal resumes after reload without another paid image request", async ({ page }) => {
  const ident = "job_" + "f".repeat(32);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XxKqWQAAAABJRU5ErkJggg==";
  let creates = 0;
  let polls = 0;
  let completed = false;
  await page.route("**/api/generate-image", (route) => {
    creates++;
    return route.fulfill({ status: 202, json: {
      job: { id: ident, status: "queued" }, sourceImage: `data:image/png;base64,${png}`,
      provider: "vertex", model: "test", mimeType: "image/png",
    } });
  });
  await page.route(`**/api/image-jobs/${ident}`, (route) => {
    polls++;
    return route.fulfill({ json: { id: ident, status: completed ? "completed" : "running" } });
  });
  await page.route(`**/api/image-jobs/${ident}/content`, (route) =>
    route.fulfill({ contentType: "image/png", body: Buffer.from(png, "base64") }));
  await page.goto("/avatar");
  await page.getByRole("button", { name: "キャラクター生成", exact: true }).click();
  await expect.poll(() => polls).toBeGreaterThan(0);
  await page.reload();
  await page.getByRole("button", { name: "キャラクター生成", exact: true }).click();
  await expect.poll(() => polls).toBeGreaterThan(1);
  completed = true;
  await expect(page.getByRole("img", { name: "生成したキャラクター", exact: true })).toHaveAttribute("src", `data:image/png;base64,${png}`);
  expect(creates).toBe(1);
});

test("production UI preview uses OpenAI for the character and all twelve avatar frames", async ({ page }) => {
  const requests = await prepareAvatar(page);
  expect(requests[0].provider).toBe("vertex");
  // Restore the saved development Vertex preference before entering the preview.
  await page.reload();
  await expect(page.getByRole("button", { name: "アバター生成", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: /本番UIを確認/ }).click();
  await expect(page.getByRole("button", { name: "Nano Banana 2", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "属性", exact: true }).click();
  await page.getByRole("button", { name: "キャラクター生成", exact: true }).click();
  await expect(page.getByRole("button", { name: "キャラクター生成", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "ポーズ", exact: true }).click();
  await selectPose(page, 2, "両手ピース");
  await selectPose(page, 3, "ガッツポーズ");
  await generateAvatar(page, 12);
  expect(requests).toHaveLength(14);
  expect(requests.slice(1).every(({ provider }) => provider === "openai")).toBe(true);
  for (const index of [2, 6, 10]) expect(requests[index].referenceImage).toBe(mockImage(1));
});

test("one pose generates four frames and keeps blinking without changing poses", async ({ page }) => {
  const requests = await prepareAvatar(page);
  await freezeClock(page);
  await generateAvatar(page, 4);
  expect(requests).toHaveLength(5);
  expect(requests[1].prompt).toContain("a natural relaxed standing pose");
  await expect(visibleAvatar(page)).toHaveAttribute("src", mockImage(1));
  await page.clock.runFor(260);
  await expect(visibleAvatar(page)).toHaveAttribute("src", mockImage(2));
  await page.clock.runFor(2540);
  await expect(visibleAvatar(page)).toHaveAttribute("alt", /ポーズ1・目閉じ/);
  await page.clock.runFor(160);
  await expect(visibleAvatar(page)).toHaveAttribute("alt", /ポーズ1・目開き/);
  await page.clock.runFor(12000);
  await expect(visibleAvatar(page)).toHaveAttribute("alt", /ポーズ1・/);
  expect(requests).toHaveLength(5);
});

test("three selected poses generate twelve frames in one run regardless of the active tab", async ({ page }) => {
  const requests = await prepareAvatar(page);
  await selectPose(page, 1, "ジャンプ");
  await selectPose(page, 2, "両手ピース");
  await selectPose(page, 3, "ガッツポーズ");
  await selectPoseGroup(page, 1);
  await freezeClock(page);
  await generateAvatar(page, 12);
  expect(requests).toHaveLength(13);
  for (let group = 1; group <= 3; group++) {
    await expectPoseFrames(page, group, 1 + (group - 1) * 4);
  }
  const instructions = [
    "jumping with both feet off the ground",
    "making peace signs with both hands",
    "a celebratory fist-pump pose",
  ];
  for (let pose = 0; pose < 3; pose++) {
    const start = 1 + pose * 4;
    expect(requests[start].prompt).toContain(instructions[pose]);
    expect(requests[start].referenceImage).toBe(mockImage(0));
    expect(requests[start + 1].referenceImage).toBe(mockImage(start));
    expect(requests[start + 2].referenceImage).toBe(mockImage(start + 1));
    expect(requests[start + 3].referenceImage).toBe(mockImage(start));
    expect(requests[start + 3].secondaryReferenceImage).toBe(mockImage(start + 2));
  }

  await page.evaluate(() => { Math.random = () => 0; });
  await page.clock.runFor(3999);
  await expect(visibleAvatar(page)).toHaveAttribute("alt", /ポーズ3・/);
  await page.clock.runFor(1);
  await expect(visibleAvatar(page)).toHaveAttribute("alt", /ポーズ1・/);
  await page.evaluate(() => { Math.random = () => 0.99; });
  await page.clock.runFor(4000);
  await expect(visibleAvatar(page)).toHaveAttribute("alt", /ポーズ3・/);
  await page.clock.runFor(4000);
  await expect(visibleAvatar(page)).toHaveAttribute("alt", /ポーズ2・/);

  const poseControls = page.getByRole("group", { name: "確認するアバターポーズ", exact: true });
  const frameControls = page.getByRole("group", { name: "確認するアバターフレーム", exact: true });
  for (let pose = 0; pose < 3; pose++) {
    await poseControls.getByRole("button", { name: `ポーズ${pose + 1}`, exact: true }).click();
    const expectedImages = [1, 2, 4, 3].map((index) => mockImage(index + pose * 4));
    for (let frame = 0; frame < 4; frame++) {
      await frameControls.getByRole("button").nth(frame).click();
      await expect(visibleAvatar(page)).toHaveAttribute("src", expectedImages[frame]);
    }
  }
  await page.clock.runFor(12000);
  await expect(visibleAvatar(page)).toHaveAttribute("src", mockImage(11));
  await page.getByRole("button", { name: "自動再生", exact: true }).click();
  await page.clock.runFor(4000);
  await expect(visibleAvatar(page)).toHaveAttribute("alt", /ポーズ2・/);
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await page.getByRole("button", { name: /本番UIを確認/ }).click();
  await expect(poseControls).toHaveCount(0);
  await page.clock.runFor(4000);
  await expect(visibleAvatar(page)).toHaveAttribute("alt", /ポーズ1・/);
  expect(requests).toHaveLength(13);
});

test("requests run one at a time with total progress, per-pose saving, and a fixed selection snapshot", async ({ page }) => {
  const replies = new Map<number, () => void>();
  const requests = await prepareAvatar(page, -1, async (index) => {
    if (index > 0) await new Promise<void>((resolve) => replies.set(index, resolve));
  });
  await selectPose(page, 2, "両手ピース");
  await selectPose(page, 3, "ガッツポーズ");
  await page.getByRole("button", { name: "アバター生成", exact: true }).click();
  for (let index = 1; index <= 12; index++) {
    await expect.poll(() => requests.length).toBe(index + 1);
    await expect(page.getByRole("status")).toHaveText(`ポーズ${Math.ceil(index / 4)}を生成しています（${index} / 12枚）。`);
    await expect(page.getByRole("button", { name: "アバター生成中...", exact: true })).toBeDisabled();
    const completed = Math.floor((index - 1) / 4);
    expect((await storedAvatarImages(page)).avatarPoses).toHaveLength(completed);
    for (let group = 1; group <= completed; group++) {
      await expectPoseFrames(page, group, 1 + (group - 1) * 4);
    }
    if (index === 1) {
      // Editing a later pose while a request is pending applies to the next run.
      await selectPose(page, 2, "腕組み");
      await selectPose(page, 3, "ガッツポーズ");
    }
    replies.get(index)!();
  }
  await expect(page.getByRole("button", { name: "アバター生成", exact: true })).toBeEnabled();
  expect((await storedAvatarImages(page)).avatarPoses).toHaveLength(3);
  expect(requests[5].prompt).toContain("making peace signs with both hands");
  expect(requests[9].prompt).toContain("a celebratory fist-pump pose");
  expect(requests).toHaveLength(13);
});

test("two selected poses generate eight frames and skip the unselected middle pose", async ({ page }) => {
  const requests = await prepareAvatar(page);
  await selectPose(page, 3, "サムズアップ");
  await selectPoseGroup(page, 2);
  await generateAvatar(page, 8);
  expect(requests).toHaveLength(9);
  await expectPoseFrames(page, 1, 1);
  await expectPoseFrames(page, 3, 5);
  expect(requests[5].prompt).toContain("giving a thumbs-up");
  expect((await storedAvatarImages(page)).avatarPoses.map(({ id }) => id)).toEqual(["basic", "reaction"]);
});

test("no selected poses shows a validation error without generating images", async ({ page }) => {
  const requests = await prepareAvatar(page);
  await selectPose(page, 1, "通常立ち");
  await page.getByRole("button", { name: "アバター生成", exact: true }).click();
  await expect(page.getByText("ポーズを1つ以上選択してください。", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
});

test("poses can be added out of order and a new character clears all previous poses", async ({ page }) => {
  const requests = await prepareAvatar(page);
  // An explicitly deselected pose is skipped, including the default pose 1.
  await selectPose(page, 1, "通常立ち");
  await selectPose(page, 2, "腕組み");
  await selectPose(page, 2, "腕組み");
  await selectPose(page, 3, "サムズアップ");
  await page.getByRole("button", { name: "ポーズ3を文章で指定", exact: true }).click();
  const instruction = "両腕を上げて大きく伸びをする";
  await page.getByRole("textbox", { name: "文章で指定", exact: true }).fill(instruction);
  await freezeClock(page);
  await generateAvatar(page, 4);
  expect(requests).toHaveLength(5);
  expect(requests[1].prompt).toContain(instruction);
  expect(requests[1].prompt).not.toContain("giving a thumbs-up");
  await expect(visibleAvatar(page)).toHaveAttribute("alt", /ポーズ3・/);
  await page.getByRole("button", { name: "ポーズ3を文章で指定", exact: true }).click();
  await selectPose(page, 3, "サムズアップ");
  await selectPose(page, 1, "通常立ち");
  await generateAvatar(page, 8);
  expect(requests).toHaveLength(9);
  expect(requests[5].prompt).toContain("a natural relaxed standing pose");
  await expectPoseFrames(page, 1, 5);
  await expectPoseFrames(page, 3, 1);
  await expect(visibleAvatar(page)).toHaveAttribute("alt", /ポーズ1・/);

  await page.getByRole("button", { name: "属性", exact: true }).click();
  await page.getByRole("button", { name: "キャラクター生成", exact: true }).click();
  await expect(page.getByRole("img", { name: "生成したキャラクター", exact: true })).toHaveAttribute("src", mockImage(9));
  await page.getByRole("tab", { name: "アバター", exact: true }).click();
  await expect(page.locator("#generated-image-panel img")).toHaveCount(0);
});

for (const group of [1, 2, 3]) {
  test(`empty custom pose ${group} is validated before any selected pose is generated`, async ({ page }) => {
    const requests = await prepareAvatar(page);
    await page.getByLabel("ポーズ項目", { exact: true })
      .getByRole("button", { name: new RegExp(`^ポーズ${group}`) }).click();
    await page.getByRole("button", { name: `ポーズ${group}を文章で指定`, exact: true }).click();
    await page.getByRole("textbox", { name: "文章で指定", exact: true }).fill("   ");
    await selectPoseGroup(page, group === 1 ? 2 : 1);
    await page.getByRole("button", { name: "アバター生成", exact: true }).click();
    await expect(page.getByText(`ポーズ${group}の文章を入力してください。`, { exact: true })).toBeVisible();
    expect(requests).toHaveLength(1);
    await page.getByRole("textbox", { name: "文章で指定", exact: true }).fill("両手でハートを作る");
    const frameCount = group === 1 ? 4 : 8;
    await generateAvatar(page, frameCount);
    expect(requests).toHaveLength(1 + frameCount);
    expect(requests[group === 1 ? 1 : 5].prompt).toContain("両手でハートを作る");
    await expectPoseFrames(page, 1, 1);
  });
}

for (const [group, label, instruction] of [
  [1, "手を振る", "waving with one hand"],
  [2, "腕組み", "standing with arms crossed"],
  [3, "サムズアップ", "giving a thumbs-up"],
] as const) {
  test(`changing pose ${group} regenerates only its four frames while all poses stay selected`, async ({ page }) => {
    const requests = await prepareAvatar(page);
    await freezeClock(page);
    await selectPose(page, 2, "両手ピース");
    await selectPose(page, 3, "ガッツポーズ");
    await generateAvatar(page, 12);
    await expect(page.getByRole("button", { name: /だけ再生成/ })).toHaveCount(0);
    await selectPose(page, group, label);
    const poseGroups = page.getByLabel("ポーズ項目", { exact: true });
    await expect(poseGroups.getByRole("button").filter({ hasText: /生成済み|変更あり|未生成/ })).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText(`生成対象：ポーズ${group}（4枚）。`);
    await generateAvatar(page, 12);
    expect(requests).toHaveLength(17);
    expect(requests[13].prompt).toContain(instruction);
    expect(requests[13].referenceImage).toBe(mockImage(0));
    for (let existing = 1; existing <= 3; existing++) {
      await expectPoseFrames(page, existing, existing === group ? 13 : 1 + (existing - 1) * 4);
    }
    await expect(visibleAvatar(page)).toHaveAttribute("src", mockImage(13));
    await expect(visibleAvatar(page)).toHaveAttribute("alt", new RegExp(`ポーズ${group}・`));
    await expect(poseGroups.getByRole("button").filter({ hasText: /生成済み|変更あり|未生成/ })).toHaveCount(0);
  });
}

for (const [group, id] of [[1, "basic"], [2, "gesture"], [3, "reaction"]] as const) {
  test(`deleting pose ${group} preserves the other poses and can regenerate just the deleted pose`, async ({ page }) => {
    const requests = await prepareAvatar(page);
    await freezeClock(page);
    await selectPose(page, 2, "両手ピース");
    await selectPose(page, 3, "ガッツポーズ");
    await generateAvatar(page, 12);
    const saved = await storedAvatarImages(page);

    await selectPoseGroup(page, group);
    await page.getByRole("button", { name: `ポーズ${group}を削除`, exact: true }).click();
    await expect(page.locator("#generated-image-panel img")).toHaveCount(8);
    await expect(page.locator(`#generated-image-panel img[alt^="生成したアバター（ポーズ${group}・"]`)).toHaveCount(0);
    await expect(visibleAvatar(page)).toHaveAttribute("alt", new RegExp(`ポーズ${group === 3 ? 2 : 3}・`));
    expect(await storedAvatarImages(page)).toEqual({
      ...saved,
      avatarPoses: saved.avatarPoses.filter((pose) => pose.id !== id),
    });

    await page.reload();
    await expect(page.locator("#generated-image-panel img")).toHaveCount(8);
    await expect(page.getByRole("button", { name: `ポーズ${group}を削除`, exact: true })).toHaveCount(0);
    expect(requests).toHaveLength(13);
    await generateAvatar(page, 12);
    expect(requests).toHaveLength(17);
    for (let existing = 1; existing <= 3; existing++) {
      await expectPoseFrames(page, existing, existing === group ? 13 : 1 + (existing - 1) * 4);
    }
  });
}

test("deleting the last pose clears its preview while keeping the character and custom settings", async ({ page }) => {
  const requests = await prepareAvatar(page);
  await selectPose(page, 1, "通常立ち");
  await selectPoseGroup(page, 2);
  await page.getByRole("button", { name: "ポーズ2を文章で指定", exact: true }).click();
  await page.getByRole("textbox", { name: "文章で指定", exact: true }).fill("片手を高く上げる");
  await generateAvatar(page, 4);
  await page.getByRole("button", { name: "ポーズ2を削除", exact: true }).click();
  await expect(page.locator("#generated-image-panel img")).toHaveCount(0);
  await expect(page.getByText("ポーズから生成したアバターがここに表示されます。", { exact: true })).toBeVisible();
  expect((await storedAvatarImages(page)).avatarPoses).toEqual([]);

  await page.reload();
  await expect(page.getByRole("button", { name: "アバター生成", exact: true })).toBeEnabled();
  await expect(page.locator("#generated-image-panel img")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "文章で指定", exact: true })).toHaveValue("片手を高く上げる");
  await page.getByRole("tab", { name: "キャラクター", exact: true }).click();
  await expect(page.getByRole("img", { name: "生成したキャラクター", exact: true })).toHaveAttribute("src", mockImage(0));
  expect(requests).toHaveLength(5);
  await generateAvatar(page, 4);
  expect(requests).toHaveLength(9);
  expect(requests[5].prompt).toContain("片手を高く上げる");
  await expectPoseFrames(page, 2, 5);
});

test("pose deletion is hidden in production UI preview and disabled during generation", async ({ page }) => {
  let releaseRequest: (() => void) | undefined;
  const requests = await prepareAvatar(page, -1, async (index) => {
    if (index === 9) await new Promise<void>((resolve) => { releaseRequest = resolve; });
  });
  await selectPose(page, 2, "両手ピース");
  await generateAvatar(page, 8);
  const deleteButton = page.getByRole("button", { name: "ポーズ2を削除", exact: true });
  await expect(deleteButton).toBeEnabled();
  await page.getByRole("button", { name: /本番UIを確認/ }).click();
  await expect(page.getByRole("button", { name: /ポーズ[123]を削除/ })).toHaveCount(0);
  await page.getByRole("button", { name: /開発UIに戻る/ }).click();

  await selectPose(page, 1, "手を振る");
  await page.getByRole("button", { name: "アバター生成", exact: true }).click();
  await selectPoseGroup(page, 2);
  await expect(deleteButton).toBeDisabled();
  await expect.poll(() => Boolean(releaseRequest)).toBe(true);
  releaseRequest!();
  await expect(page.getByRole("button", { name: "アバター生成", exact: true })).toBeEnabled();
  await expect(deleteButton).toBeEnabled();
  expect(requests).toHaveLength(13);
});

test("a failed pose deletion preserves saved images and allows retry", async ({ page }) => {
  const requests = await prepareAvatar(page);
  await selectPose(page, 2, "両手ピース");
  await generateAvatar(page, 8);
  const saved = await storedAvatarImages(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.transaction.db.name === "chibichara-avatar" && key === "images") {
        IDBObjectStore.prototype.put = original;
        throw new DOMException("Test storage failure", "UnknownError");
      }
      return original.call(this, value, key);
    };
  });
  const deleteButton = page.getByRole("button", { name: "ポーズ2を削除", exact: true });
  await deleteButton.click();
  await expect(page.getByRole("alert").filter({ hasText: "ポーズを削除できませんでした" })).toBeVisible();
  await expectPoseFrames(page, 1, 1);
  await expectPoseFrames(page, 2, 5);
  expect(await storedAvatarImages(page)).toEqual(saved);

  await deleteButton.click();
  await expect(page.locator("#generated-image-panel img")).toHaveCount(4);
  await expect(page.getByRole("alert").filter({ hasText: "ポーズを削除できませんでした" })).toHaveCount(0);
  expect((await storedAvatarImages(page)).avatarPoses).toEqual(saved.avatarPoses.filter(({ id }) => id !== "gesture"));
  expect(requests).toHaveLength(9);
});

for (const group of [2, 3]) {
  test(`viewing unselected pose ${group} still generates selected pose 1`, async ({ page }) => {
    const requests = await prepareAvatar(page);
    await selectPoseGroup(page, group);
    await generateAvatar(page, 4);
    await expectPoseFrames(page, 1, 1);
    expect(requests).toHaveLength(5);
  });
}

test("a failed batch saves completed replacements and preserves unfinished and remaining poses", async ({ page }) => {
  const requests = await prepareAvatar(page, 18);
  await freezeClock(page);
  await selectPose(page, 2, "両手ピース");
  await selectPose(page, 3, "ガッツポーズ");
  await generateAvatar(page, 12);
  await selectPose(page, 1, "ジャンプ");
  await selectPose(page, 2, "腕組み");
  await selectPose(page, 3, "サムズアップ");
  await page.getByRole("button", { name: "アバター生成", exact: true }).click();
  await expect(page.getByText("テスト用の生成エラー", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "アバター生成", exact: true })).toBeEnabled();
  expect(requests).toHaveLength(19);
  await expect(page.locator("#generated-image-panel img")).toHaveCount(12);
  await expectPoseFrames(page, 1, 13);
  await expectPoseFrames(page, 2, 5);
  await expectPoseFrames(page, 3, 9);
  await page.reload();
  await expectPoseFrames(page, 1, 13);
  await expectPoseFrames(page, 2, 5);
  await expectPoseFrames(page, 3, 9);
  expect(requests).toHaveLength(19);
  await generateAvatar(page, 12);
  expect(requests).toHaveLength(27);
  await expectPoseFrames(page, 1, 13);
  await expectPoseFrames(page, 2, 19);
  await expectPoseFrames(page, 3, 23);
  await expect(page.getByText("テスト用の生成エラー", { exact: true })).toHaveCount(0);
});

test("character, pose sets, and editor settings survive reload without regenerating images", async ({ page }) => {
  const requests = await prepareAvatar(page);
  await expect.poll(async () => (await storedAvatarImages(page))?.character.image).toBe(mockImage(0));
  await page.reload();
  await expect(page.getByRole("img", { name: "生成したキャラクター", exact: true })).toHaveAttribute("src", mockImage(0));
  await expect(page.getByRole("button", { name: "アバター生成", exact: true })).toBeEnabled();
  expect(requests).toHaveLength(1);

  const labels = ["ジャンプ", "両手ピース", "サムズアップ"];
  for (let group = 1; group <= 3; group++) {
    const firstImage = requests.length;
    await selectPose(page, group, labels[group - 1]);
    if (group === 2) {
      await page.getByRole("button", { name: "ポーズ2を文章で指定", exact: true }).click();
      await page.getByRole("textbox", { name: "文章で指定", exact: true }).fill("両手でハートを作る");
    }
    await generateAvatar(page, group * 4);
    await expect.poll(async () => (await storedAvatarImages(page)).avatarPoses.length).toBe(group);
    await page.reload();
    await expect(page.getByRole("button", { name: "アバター生成", exact: true })).toBeEnabled();
    await expect(page.getByRole("tab", { name: "アバター", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("ポーズ項目", { exact: true }).getByRole("button", { name: new RegExp(`^ポーズ${group}`) })).toHaveAttribute("aria-pressed", "true");
    for (let existing = 1; existing <= group; existing++) {
      await expectPoseFrames(page, existing, 1 + (existing - 1) * 4);
    }
    if (group === 2) {
      await expect(page.getByRole("textbox", { name: "文章で指定", exact: true })).toHaveValue("両手でハートを作る");
    } else {
      await expect(page.getByRole("button", { name: labels[group - 1], exact: true })).toHaveAttribute("aria-pressed", "true");
    }
    expect(requests).toHaveLength(firstImage + 4);
  }
  await page.getByRole("tab", { name: "キャラクター", exact: true }).click();
  await expect(page.getByRole("img", { name: "生成したキャラクター", exact: true })).toHaveAttribute("src", mockImage(0));
  expect(requests[5].prompt).toContain("両手でハートを作る");
  for (const index of [1, 5, 9]) expect(requests[index].referenceImage).toBe(mockImage(0));
});

test("unchanged or reverted pose settings send no image requests", async ({ page }) => {
  const requests = await prepareAvatar(page);
  await selectPose(page, 2, "両手ピース");
  await selectPose(page, 3, "ガッツポーズ");
  await generateAvatar(page, 12);
  const saved = await storedAvatarImages(page);
  await selectPose(page, 2, "腕組み");
  await selectPose(page, 2, "両手ピース");
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByLabel("ポーズ項目", { exact: true }).getByText("変更あり", { exact: true })).toHaveCount(0);
  await generateAvatar(page, 12);
  expect(requests).toHaveLength(13);
  expect(await storedAvatarImages(page)).toEqual(saved);
});

test("the main generation button updates both changed poses even while viewing the unchanged pose", async ({ page }) => {
  const requests = await prepareAvatar(page);
  await selectPose(page, 2, "両手ピース");
  await selectPose(page, 3, "ガッツポーズ");
  await generateAvatar(page, 12);
  await selectPose(page, 1, "手を振る");
  await selectPose(page, 3, "サムズアップ");
  await selectPoseGroup(page, 2);
  await expect(page.getByRole("status")).toHaveText("生成対象：ポーズ1・ポーズ3（8枚）。");
  await expect(page.getByRole("button", { name: /だけ再生成/ })).toHaveCount(0);
  await generateAvatar(page, 12);
  expect(requests).toHaveLength(21);
  expect(requests[13].prompt).toContain("waving with one hand");
  expect(requests[17].prompt).toContain("giving a thumbs-up");
  await expectPoseFrames(page, 1, 13);
  await expectPoseFrames(page, 2, 5);
  await expectPoseFrames(page, 3, 17);
});

test("custom pose changes survive reload and regenerate only the edited pose", async ({ page }) => {
  const requests = await prepareAvatar(page);
  await selectPose(page, 2, "両手ピース");
  await page.getByRole("button", { name: "ポーズ2を文章で指定", exact: true }).click();
  await page.getByRole("textbox", { name: "文章で指定", exact: true }).fill("両手でハートを作る");
  await generateAvatar(page, 8);
  await page.getByRole("textbox", { name: "文章で指定", exact: true }).fill("片手を高く上げる");
  // Wait for the editor snapshot rather than relying on a reload race.
  await expect.poll(() => page.evaluate(async () => {
    const request = indexedDB.open("chibichara-avatar", 1);
    const db = await new Promise<IDBDatabase>((resolve) => { request.onsuccess = () => resolve(request.result); });
    try {
      return await new Promise<string>((resolve) => {
        const read = db.transaction("session").objectStore("session").get("editor");
        read.onsuccess = () => resolve(read.result?.poseCustomPrompts.gesture);
      });
    } finally { db.close(); }
  })).toBe("片手を高く上げる");
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("生成対象：ポーズ2（4枚）。");
  expect(requests).toHaveLength(9);
  await generateAvatar(page, 8);
  expect(requests).toHaveLength(13);
  expect(requests[9].prompt).toContain("片手を高く上げる");
  await expectPoseFrames(page, 1, 1);
  await expectPoseFrames(page, 2, 9);
});

test("legacy saved poses gain a baseline without regenerating all images", async ({ page }) => {
  const requests = await prepareAvatar(page);
  await selectPose(page, 2, "両手ピース");
  await selectPose(page, 3, "ガッツポーズ");
  await generateAvatar(page, 12);
  await page.evaluate(async () => {
    const request = indexedDB.open("chibichara-avatar", 1);
    const db = await new Promise<IDBDatabase>((resolve) => { request.onsuccess = () => resolve(request.result); });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("session", "readwrite");
        const store = transaction.objectStore("session");
        const read = store.get("images");
        read.onsuccess = () => {
          for (const pose of read.result.avatarPoses) delete pose.instruction;
          store.put(read.result, "images");
        };
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { db.close(); }
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "アバター生成", exact: true })).toBeEnabled();
  expect(requests).toHaveLength(13);
  await selectPose(page, 3, "サムズアップ");
  await generateAvatar(page, 12);
  expect(requests).toHaveLength(17);
  await expectPoseFrames(page, 1, 1);
  await expectPoseFrames(page, 2, 5);
  await expectPoseFrames(page, 3, 13);
});

test("persisted replacements are atomic and a new character removes stored old poses", async ({ page }) => {
  const requests = await prepareAvatar(page, 15);
  await selectPose(page, 2, "両手ピース");
  await generateAvatar(page, 8);
  await selectPose(page, 2, "両手ピース");
  await selectPose(page, 1, "ジャンプ");
  await generateAvatar(page, 8);
  await page.reload();
  await expect(page.getByRole("button", { name: "アバター生成", exact: true })).toBeEnabled();
  await expectPoseFrames(page, 1, 9);
  await expectPoseFrames(page, 2, 5);
  const saved = await storedAvatarImages(page);

  await selectPose(page, 1, "ジャンプ");
  await selectPose(page, 2, "腕組み");
  await page.getByRole("button", { name: "アバター生成", exact: true }).click();
  await expect(page.getByText("テスト用の生成エラー", { exact: true })).toBeVisible();
  expect(await storedAvatarImages(page)).toEqual(saved);
  await page.reload();
  await expectPoseFrames(page, 1, 9);
  await expectPoseFrames(page, 2, 5);
  expect(requests).toHaveLength(16);

  await page.getByRole("button", { name: "属性", exact: true }).click();
  await page.getByRole("button", { name: "キャラクター生成", exact: true }).click();
  await expect(page.getByRole("button", { name: "キャラクター生成", exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole("img", { name: "生成したキャラクター", exact: true })).toHaveAttribute("src", mockImage(16));
  await page.getByRole("tab", { name: "アバター", exact: true }).click();
  await expect(page.locator("#generated-image-panel img")).toHaveCount(0);
  expect((await storedAvatarImages(page)).avatarPoses).toEqual([]);
  expect(requests).toHaveLength(17);
});

test("a failed character regeneration keeps the saved character and poses", async ({ page }) => {
  const requests = await prepareAvatar(page, 5);
  await generateAvatar(page, 4);
  const saved = await storedAvatarImages(page);
  await page.getByRole("button", { name: "属性", exact: true }).click();
  await page.getByRole("button", { name: "キャラクター生成", exact: true }).click();
  await expect(page.getByText("テスト用の生成エラー", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("img", { name: "生成したキャラクター", exact: true })).toHaveAttribute("src", mockImage(0));
  await page.getByRole("tab", { name: "アバター", exact: true }).click();
  await expectPoseFrames(page, 1, 1);
  expect(await storedAvatarImages(page)).toEqual(saved);
  expect(requests).toHaveLength(6);
});

test("a storage read failure does not overwrite previously saved images", async ({ page }) => {
  await prepareAvatar(page);
  await generateAvatar(page, 4);
  const saved = await storedAvatarImages(page);
  await page.addInitScript(() => {
    const original = IDBFactory.prototype.open;
    let fail = true;
    IDBFactory.prototype.open = function (name, version) {
      if (name === "chibichara-avatar" && fail) {
        fail = false;
        throw new DOMException("Test storage read failure", "UnknownError");
      }
      return original.call(this, name, version);
    };
  });
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "保存した画像を読み込めませんでした" })).toBeVisible();
  expect(await storedAvatarImages(page)).toEqual(saved);
  await page.getByRole("button", { name: "キャラクター生成", exact: true }).click();
  await expect(page.getByRole("button", { name: "キャラクター生成", exact: true })).toBeEnabled();
  expect(await storedAvatarImages(page)).toEqual(saved);
});

test("a storage write failure keeps the previous snapshot and explains unsaved images", async ({ page }) => {
  const requests = await prepareAvatar(page);
  await expect.poll(async () => (await storedAvatarImages(page))?.character.image).toBe(mockImage(0));
  const saved = await storedAvatarImages(page);
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.transaction.db.name === "chibichara-avatar" && key === "images") {
        throw new DOMException("Test storage full", "QuotaExceededError");
      }
      return original.call(this, value, key);
    };
  });
  await page.reload();
  await generateAvatar(page, 4);
  await expect(page.getByRole("alert").filter({ hasText: "画像をブラウザに保存できませんでした" })).toBeVisible();
  expect(await storedAvatarImages(page)).toEqual(saved);
  await page.reload();
  await expect(page.getByRole("button", { name: "アバター生成", exact: true })).toBeEnabled();
  await expect(page.locator("#generated-image-panel img")).toHaveCount(0);
  await page.getByRole("tab", { name: "キャラクター", exact: true }).click();
  await expect(page.getByRole("img", { name: "生成したキャラクター", exact: true })).toHaveAttribute("src", mockImage(0));
  expect(requests).toHaveLength(5);
});
