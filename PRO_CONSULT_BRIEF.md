# HarmoGraph Pro相談メモ（2026-02-22）

## 1. 目的と現状のズレ
- 目的: 参照ボーカル/コーラスに対して、ユーザ歌唱の「音高+リズム」を練習用途で高精度フィードバックしたい。
- 現状: 「有声音セルのカバレッジ」は上がるが、聴感上は参照と同等品質に聞こえないケースが多い。
- 重要: 現在の指標最適化が「似ている音楽性」ではなく「セルが埋まっている率」に寄りすぎている可能性が高い。

## 2. 現在の技術構成
- Frontend: `Vite + React + TypeScript`
- 音声I/O: Web Audio API + MediaRecorder
- ピッチ推定: `@spotify/basic-pitch`（`src/lib/modelPitch.ts`）
- 解析: `src/lib/analyzer.ts`
- ノート化/MIDIプレビュー: `src/lib/midiPreview.ts`
- 保存: IndexedDB（Project単位）
- デバッグ保存: `debug/latest-analysis.json`（自動保存）

## 3. 主要データモデル
- `Project`
  - `tracks`（vocal/chorus, blob, offsetMs）
  - `sessions`
  - `referenceAlignConfig`（clickEnabled, clickVolume, bpm, beatsPerBar, clickOffsetMs）
- `Session`
  - `recording`
  - `analysisConfig`
  - `rhythmConfig`（bpm, clickOffsetMs, subdivision=4）
  - `analysisResult`（refPitch, userPitch, errorFrames, stats, topSegments）

参照: `src/types.ts`

## 4. 解析パイプライン（現実装）
1. 参照/ユーザ音声をBasic Pitchでフレーム推定
2. `clarityThreshold` 未満を null 化
3. BPM + clickOffset で16分グリッド化（cell中央値）
4. ユーザ側の欠損補完（現在かなり強い）
   - 短ギャップ補完
   - 参照有声音セル上での保持補完
   - guided reference fill（近傍条件を満たすと参照音高を補う）
5. 誤差計算（cents）と統計算出

参照: `src/lib/analyzer.ts`

## 5. MIDIプレビューのパイプライン（現実装）
- グリッド解析済み `userPitch` からノート化（`extractGridAlignedNoteEvents`）
- 同音高連結は `maxMergeCells=2` で制限
- ただし元の `autoExtractBestNoteEvents` 系ロジックも残存（用途が混在）

参照: `src/lib/midiPreview.ts`, `src/App.tsx`

## 6. 直近の主要変更履歴
- 16分グリッド主評価へ移行: `9e5a90e`
- MIDIをグリッド時間軸へ寄せる: `dbeef6f`
- click/BPM設定永続化: `4bc1376`
- カバレッジ改善系（欠損補完強化）:
  - `504e007`
  - `2d9f55a`
  - `45d5ab7`
  - `116e9c5`
  - `1cabc0d`

## 7. 直近デバッグ値（latest）
`debug/latest-analysis.json` より:
- rhythm: `bpm=160`, `clickOffsetMs=-320`, `subdivision=4`
- ref frames: `576`（detected `425`）
- user frames: `456`（detected `356`）
- notes: `197`
- stats:
  - meanAbsCents: `1223.14`
  - medianAbsCents: `1200`
  - passRatio: `0.0029`
  - undetectedRatio: `0.392`

所感:
- detected数は増えているが、cents誤差は非常に大きく、聴感品質とも一致していない。

## 8. 問題の本質（仮説）
1. **指標ミスマッチ**
   - 「有声音セルを埋める最適化」と「参照に似た旋律/リズム」は一致しない。
2. **補完のリーク**
   - guided reference fillにより、実測不足を参照由来で埋めてしまい、評価の意味が崩れる。
3. **単旋律仮定の破綻**
   - 実音源条件（漏れ、倍音、子音、ビブラート）でf0抽出が不安定。
4. **評価粒度の不足**
   - 現在はセル単位中心。ノート境界一致（onset/offset）やノート長誤差を主指標にしていない。

## 9. Proに相談したいこと（具体）
1. 練習用途として妥当な評価関数設計
   - pitch誤差
   - onset/offset誤差
   - note length誤差
   - voiced/unvoiced判定
   の重みづけ
2. 16分固定グリッド vs 可変ノート境界推定（onset併用）
3. 欠損補完の上限設計
   - どこまで補完してよいか（評価汚染を避ける制約）
4. Basic Pitch後段の最適な後処理
   - HMM/Viterbi再設計
   - オクターブエラー抑制
   - 信頼度の扱い
5. MIDIプレビューと解析指標の整合設計
   - 可視化/再生が評価軸と1:1対応するようにしたい

## 10. 再現手順（相談相手に渡す用）
1. プロジェクトを開く
2. 参照ボーカル/コーラスを登録
3. BPM=160, clickOffset=-320付近で位置合わせ
4. 練習録音→再解析
5. `debug/latest-analysis.json` と画面（解析グラフ + MIDIプレビュー）を比較
6. 「カバレッジは高いが、聴感上似ていない」ケースを確認

## 11. 提案する次の改修方針（自分案）
- 強い参照コピー補完（guided fill）を停止/弱化するフラグを設ける
- 「補完なし（実測のみ）」と「補完あり」を別トラックで可視化
- 最終スコアは
  - `PitchMAE(cents)`
  - `OnsetMAE(ms)`
  - `DurationError`
  - `Voiced F1`
  の複合にする
- MIDIプレビューは評価対象データのみを使う（後段加工を最小化）

