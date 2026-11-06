# 인수인계: 배드민턴 자동 점수 카운트 (Smash Score)

> 최초 작성: 2026-11-04 · 갱신: 2026-11-04 (서버 버전 새로 구현)
> 대상: 이 프로젝트를 이어서 작업할 개발자 / 코딩 에이전트

---

## 1. 프로젝트 개요

**목표:** 배드민턴(복식) 경기 영상을 업로드하면 자동으로 점수를 세어 주는 웹페이지.

**핵심 아이디어: 서브 대형 기반 점수 계산**
- 랠리포인트제라서 **랠리를 이긴 팀이 다음 서브를 넣는다.**
- 셔틀이 어디 떨어졌는지 몰라도 **누가 서브하는지만 알면 점수를 계산할 수 있다.**
- 서브 직전에는 **4명이 모두 멈춰 서브 대형을 만든다.** 이 순간을 잡아 서버 팀 점수를 +1 한다.

**확정된 결정 사항**
| 항목 | 결정 |
|---|---|
| 셔틀콕 검출/추적 | **사용하지 않음** |
| 사람 검출 | `Models/Detector/detect.pt` (**YOLOv7**, 7클래스, 0번 = person) → ONNX로 변환해서 사용 |
| 포즈 추정 | `Models/PoseEstimation/bpe.alphapose_resnet50_se.i192x256...onnx` (**AlphaPose FastPose**, Top-down) |
| 추론 엔진 | **onnxruntime-gpu** (웹 서버는 YOLOv7 저장소 코드에 의존하지 않음) |
| 코트 영역 | 사용자가 꼭짓점 4개 지정 → 호모그래피 |
| 팀 구분 | 사용자가 기준 프레임에서 팀 A/B 선수 선택. 분석 중에는 **네트 기준 위/아래(far/near)** 로 추적 |
| 웹 | **FastAPI** + 순수 HTML/CSS/JS (빌드 도구 없음) |
| 디자인 | `court_ui_mockup.html` 시안 기반, 라이트/다크 모드 |
| 실행 환경 | 서버 `jeongjaemin_ai@172.16.4.100`, A100 (GPU 0 사용) |

> 이전 계획(yolo26s, ultralytics, OpenCV GUI `setup_tool.py`, PC 경로 `D:\재민\...`)은 **코드가 없어서 폐기**하고 서버에서 새로 구현했다.

---

## 2. 전체 파이프라인 (구현됨)

```
영상 업로드 (웹)
  → 프레임 선택 (선수 수 기반 추천 프레임)
  → 코트 꼭짓점 4개 지정 (형광 라인 미리보기 + 돋보기)
  → 선수 선택 (Detector + Pose 결과를 영상 위에 표시, 위/아래 자동 배정)
  → 경기 설정 (첫 서브 팀, 시작 점수/게임, 우리 팀, 21/15점)
  → [분석] Detector(사람) → far/near 슬롯 추적(헝가리안) → Top-down Pose
  → [분석] 4명 정지 구간 → 서브 대형 확인 → 서버 쪽 단서(자세·손목 움직임)
  → [분석] 점수 상태머신 + 빔 서치 (짝/홀 위치 규칙, 게임 종료, 코트 교대)
  → 결과: 실시간 스코어보드 + 점수 흐름 차트 + 서브 수정 + 점수 합성 영상(H.264)
  → 유튜브 공개용: 머리(head) 모자이크, 고른 선수 번호만 얼굴 공개 → public.mp4
```

---

## 3. 실행 방법

```bash
cd /home/jeongjaemin_ai/jeongjaemin/badminton
./run.sh            # 포트 8000, GPU 0   (./run.sh 8010 1 → 포트 8010, GPU 1)
```
- 내 PC에서 접속: `ssh -L 8000:localhost:8000 jeongjaemin_ai@172.16.4.100` 후 브라우저에서 `http://localhost:8000`
- API 문서: `http://localhost:8000/docs`

### 코드 받기
- GitHub: https://github.com/jaemin1626/Badminton
- 모델 파일(`Models/**/*.pt`, `*.onnx`, 약 600MB)은 **저장소에 없음** (.gitignore). 서버 `/home/jeongjaemin_ai/jeongjaemin/badminton/Models/`에서 직접 복사:
  `Models/Detector/detect.pt`, `Models/PoseEstimation/bpe.alphapose_resnet50_se.i192x256.db.v0.5.1.onnx`
  (`detect.i1120x640.onnx`는 `tools/export_detector.py`로 다시 만들 수 있음)

### 환경 (이미 설치됨)
- `.venv/` (Python 3.12). 새로 만들 때:
```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```
- onnxruntime-gpu는 CUDA 13 / cuDNN 9가 필요. torch가 설치하는 `nvidia-*` pip 패키지 + `nvidia-curand`로 해결하고,
  `app/vision.py`에서 `onnxruntime.preload_dlls()`로 미리 로드한다. (시스템 CUDA 설치 불필요)

### Detector를 다시 변환할 때 (detect.pt가 바뀐 경우)
```bash
.venv/bin/python tools/export_detector.py --yolov7 ~/yolov7 --weights Models/Detector/detect.pt --imgsz 640 1120
# → Models/Detector/detect.i1120x640.onnx  (출력 [N, A, 5+nc], NMS 없음, names를 메타데이터에 저장)
```
- YOLOv7 `attempt_load()`는 경로를 소문자로 바꿔서(`Models`→`models`) 실패하므로 체크포인트를 직접 로드한다.
- torch 2.15에서는 `dynamo=False`로 export 해야 한다 (기본 exporter는 onnxscript 필요).

---

## 4. 폴더 구조

```
badminton/
├─ HANDOFF.md                 이 문서
├─ court_ui_mockup.html       최초 디자인 시안 (참고용)
├─ run.sh / requirements.txt
├─ Models/
│  ├─ Detector/detect.pt                    YOLOv7 원본 (7클래스, 학습 imgsz 896)
│  ├─ Detector/detect.i1120x640.onnx        웹 서버가 쓰는 변환본
│  └─ PoseEstimation/bpe.alphapose_resnet50_se.i192x256.db.v0.5.1.onnx
├─ tools/export_detector.py   .pt → ONNX 변환
├─ app/
│  ├─ main.py        FastAPI 라우트, 저장소, 백그라운드 작업(Job)
│  ├─ vision.py      Detector / Pose ONNX 추론 (전처리·후처리 포함)
│  ├─ court.py       코트 좌표계, 호모그래피, 서비스 코트 판정
│  ├─ analysis.py    추적 → 서브 후보 → 점수 상태머신(빔 서치)
│  ├─ render.py      스코어보드 합성 영상, 브라우저용 미리보기 변환
│  ├─ privacy.py     공개용 마스킹 (head 모자이크, 선수 번호 제외)
│  ├─ assets/        영상 합성용 폰트 (Noto Sans KR, Barlow Condensed)
│  └─ static/        index.html, style.css, app.js
└─ data/videos/<영상ID>/      업로드·분석 결과 (git 제외)
   ├─ source.mp4, meta.json, thumb.jpg
   ├─ match.json             코트 + 팀 + 경기 설정 (이전 match.json 형식 유지 + "match" 항목 추가)
   ├─ tracks.npz, players.csv
   ├─ serves_raw.json, result.json, events.csv
   └─ overlay.mp4, public.mp4(공개용), preview.mp4(코덱 변환 시)
```

---

## 5. 주요 코드 설명

### 5.1 모델 (`app/vision.py`)
- **Detector**: letterbox 1120×640, RGB, /255. 점수 = obj × cls(person). NMS는 numpy로 처리.
  사람은 IoU 0.65(`Params.det_iou`): 서브 때 앞뒤로 겹쳐 선 팀원 박스가 지워지지 않게 0.5보다 높게 둠. 머리 마스킹은 0.5.
  A100 기준 1080p 프레임당 약 17 ms.
- **Pose**: 박스 → 종횡비 192:256로 늘리고 1.25배 확장 → affine crop → RGB/255 − mean(0.406, 0.457, 0.480).
  히트맵 argmax + 1/4 픽셀 보정 → 원본 좌표 복원. COCO 17관절.
- 두 모델 모두 `get_models()`로 프로세스당 한 번만 로드. GPU 번호는 환경변수 `BADMINTON_GPU`.

### 5.2 코트 좌표계 (`app/court.py`)
- 단위 m, 복식 외곽선 기준 6.10 × 13.40, 네트 `y = 6.70`. `(0,0)` = 화면 위-왼쪽(far).
- 꼭짓점 순서: far-left → far-right → near-right → near-left.
- 발 위치: 발목 관절이 믿을 만하면 발목 기준, 아니면 박스 아래 중앙.
- 서비스 코트 좌우: far 선수는 카메라를 보므로 **오른쪽 = 화면 왼쪽**, near 선수는 **오른쪽 = 화면 오른쪽**.

### 5.3 추적 (`analysis.track`)
- 분석 프레임레이트 15 fps(`Params.sample_fps`), 8프레임씩 배치 검출.
- 3단계로 돈다: ① 영상 전체 검출만 저장 → ② 매칭 → ③ 매칭된 선수 박스에만 Pose (영상을 두 번 디코딩).
- 매칭은 **설정 프레임(`ref_frame`)에서 시작해 앞으로 한 번, 뒤로 한 번** 한다.
  설정 프레임에서는 사용자가 고른 박스와 가장 많이 겹치는 검출을 그대로 슬롯에 넣는다.
- 슬롯 `far0, far1, near0, near1`. 각 쪽 후보(플레이 영역 안, 그 쪽 코트)를 직전 위치와의 거리로 헝가리안 매칭.
  코트 바깥 후보는 감점.
- **심판(`officials`)**: 설정에서 지정한 심판·선심은 따로 추적한다(마지막 위치 1.2 m 이내 또는 박스 IoU>0.3).
  심판에 잡힌 사람과 심판 위치 0.6 m 이내 사람은 선수 후보에서 뺀다. `tracks.npz`의 `off_box`에 기록.
- **가려짐 상태(`occ=1`)**: 이번 프레임에 못 찾은 선수의 마지막 박스가 지금 검출된 누군가의 박스에
  30% 이상 덮여 있으면, 그 사람 뒤에 가려져 그 자리에 서 있다고 보고 마지막 위치를 유지한다(최대 3초).
  복식 서브 때 서버 뒤 팀원(먼 쪽), 또는 팀원 뒤 서버(가까운 쪽)가 대표적인 경우.
  다시 나온 위치가 1 m 넘게 떨어져 있으면 가려진 동안 움직인 것으로 보고 추정값을 지운다.
  `tracks.npz`의 `occ`, `players.csv`의 `occluded` 열에 기록.
- 팀은 위치(far/near)로 추적하고, **위치 → 팀 매핑은 점수 상태머신이 게임별로 결정**(게임마다 코트 교대, 3게임은 11점에 교대).

### 5.4 서브 검출 (`analysis.find_serves`)
1. 위치 보간·평활 → 속도. **위치를 아는 선수(직접 보임 + 가려짐 추정)가 모두 0.55 m/s 미만**이고
   양쪽에 최소 1명씩 있는 상태가 0.6초 이상이면 정지 구간. 위치를 모르는 선수 때문에 서브를 버리지 않는다.
2. 대형 확인: 양쪽에서 네트에 가까운 선수(슬롯 번호와 무관)가 서비스 코트 안 + **대각선**(같은 right/left).
3. **정지 직후 2.5초 안에 랠리(1.6 m/s 이상)가 시작**돼야 서브로 인정. 랠리 없이 연달아 멈추면 마지막 것만 남김.
4. 서버 쪽 단서 → `p_near` (near 쪽이 서버일 확률):
   - 자세: 두 손목이 허리 앞에 모여 있으면 +, 손목이 어깨 위(라켓 든 리시버)면 −
   - 정지가 끝날 때 손목이 먼저 움직인 쪽
   - (복식, 약한 가중치 0.5) 대형: 팀원이 앞사람 바로 뒤에 서 있거나 가려졌으면 서브 팀 쪽. 실제 영상으로 검증 필요
5. `view` = 서브 때 선수를 몇 명이나 봤나: 4명 보임 1.0 / 일부 가려짐 추정 0.8 / 1명 모름 0.6 / 앞의 2명만 0.35.
   점수 계산에서 `p_near`를 0.5 쪽으로 `view`만큼 줄이고, 0.6 미만이면 "서브 때 선수가 일부 안 보임" 표시.

### 5.5 점수 계산 (`analysis.score_events`)
- 가설(어느 팀이 서브했나)마다 다음 상태를 만들고, `log p(서버 쪽) + 짝/홀 위치 불일치 감점(−2.2)`으로 평가.
- **빔 서치(폭 64)** 로 경기 전체에서 가장 그럴듯한 흐름을 고른다. 뒤쪽 서브 위치가 앞쪽 판단을 바로잡는다.
- 신뢰도 = 빔 확률 중 같은 선택 비율. 0.75 미만이면 "서버 판단 불확실" 표시.
- 수동 수정: `override`(서버 팀 지정), `removed`, `kind="point"`(영상 마지막 랠리 승자). 수정하면 나머지를 다시 계산.
- 경기 첫 서브는 점수 없음. 21점(20:20부터 2점 차, 최대 30) / 15점, 3판 2선승.

### 5.6 공개용 마스킹 (`app/privacy.py`)
- 대상: Detector의 **`head` 클래스(인덱스 2)**. 클래스 순서는 `person, car, head, wheelchair, stroller, plate, heavy_machine`.
  인덱스를 하드코딩하지 않고 `det.cls_id("head")`로 찾는다.
- 매 프레임(샘플링 없이) 8장씩 배치 검출 → 박스를 25% 넓혀 모자이크. 검출이 끊겨도 0.3초간 마스크 유지.
- **선수 번호**: 복식 1·2 = 팀 A, 3·4 = 팀 B (단식 1 = A, 2 = B). 팀 안 순서는 설정 때 고른 박스를 코트 왼쪽부터 정렬.
  추적 슬롯 `{side}{idx}`와 같고, 위치→팀 매핑은 이벤트의 `sides` 기록으로 프레임마다 계산(코트 교대 반영).
- 제외 판정: 제외 선수의 추적 박스(샘플 사이 선형 보간) 윗부분 45% 안에 머리 중심이 있으면 가리지 않음.
- **한계**: 같은 팀 두 선수가 엇갈리거나 게임이 바뀌면 팀 안 번호(1↔2)가 바뀔 수 있다. 팀 전체를 공개할 때는 영향 없음.
  머리 검출을 놓친 프레임이 있을 수 있으니 업로드 전에 한 번 훑어볼 것.
- 속도: 1080p 15fps 1분 영상 약 32초 (A100, GPU 풀에서 실행).

### 5.7 API
```
GET   /api/health                       모델·GPU 상태
POST  /api/videos                       업로드 (multipart) → meta
GET   /api/videos                       목록
GET   /api/videos/{id}                  meta + config + 진행 중 작업
DELETE /api/videos/{id}
GET   /api/videos/{id}/frames/{idx}?w=  프레임 JPEG
GET   /api/videos/{id}/suggest-frames   추천 프레임
POST  /api/videos/{id}/detect           {frame, corners} → 사람 박스 + 관절 + 코트 좌표
PUT   /api/videos/{id}/config           코트 + 팀 + 경기 설정 → match.json
POST  /api/videos/{id}/analyze          분석 시작 → job
GET   /api/jobs/{job_id}                진행률 (단계별)
POST  /api/jobs/{job_id}/cancel
GET   /api/videos/{id}/result           서브 이벤트 + 점수
PATCH /api/videos/{id}/events           [{id, action: set_server|clear|remove|restore|add_serve|add_point, team, t}]
POST  /api/videos/{id}/rescore          설정만 바꾼 뒤 점수 재계산
POST  /api/videos/{id}/render           {mask, exclude:[선수 번호], scoreboard} → overlay.mp4 또는 public.mp4 (job)
GET   /api/videos/{id}/players          선수 번호 목록,  /players/{no}/thumb  설정 프레임 상반신 썸네일
GET   /api/videos/{id}/stream?kind=     영상 재생 (auto|source|preview|overlay|public, Range 지원)
GET   /api/videos/{id}/download/{name}  result.json, events.csv, players.csv, match.json, overlay.mp4, public.mp4
```
- 작업은 메모리에 저장된다. 서버를 다시 시작하면 진행 중이던 작업 정보가 사라진다(결과 파일은 남음).
- GPU 작업은 한 번에 하나(`GPU_POOL`), 렌더링·변환은 CPU 풀 2개.

### 5.8 실험 페이지 (`/lab`, `app/lab.py`, `app/static/lab/`)
운영 화면과 분리된 알고리즘 확인용 페이지. 설정·결과는 `data/videos/<id>/lab/`에만 저장하고 운영 파일은 건드리지 않는다.
- **1 · 설정**: 코트 점, 이 프레임에서 사람 찾기 → 팀 A·B 선수와 심판 지정, 경기 설정 → 저장 / 추적 실행.
  - 코트는 꼭짓점 대신 **보이는 교차점과 라인**으로 지정한다 (`lab.fit_court`).
    - 기본 도면은 바깥 사각형(꼭짓점 4개 + 바깥 라인 4개)과 네트 기둥 바닥 2개만 보인다. "안쪽 라인·교차점도"를 켜면 전부.
    - 교차점: 도면(라인 교차점 30개 + 네트 기둥 바닥 2개)에서 고르고 영상에서 클릭. 1개 = 식 2개.
    - 라인: 끝이 화면 밖으로 잘린 경우용. 도면에서 라인을 고르고 영상에서 그 라인 위 아무 곳이나 2점 이상 클릭. 1개 = 식 2개.
    - 식이 8개 이상이면 계산(선형 DLT → 점 재투영 거리·라인까지 거리 최소제곱). 점·라인별 오차(px)와
      검산 여유(식 수 − 8)를 보여 준다. 여유가 0이면 오차가 항상 0이라 잘못 찍어도 알 수 없다.
    - 시뮬레이션: 네트 근처 점 4개만이면 2px 흔들림에 꼭짓점이 136px 어긋났고, 잘린 라인 2개를 더하면 16px.
    - 왼쪽·오른쪽은 카메라에서 볼 때 기준이며, 바꿔 찍으면(좌우 뒤집힘) 경고한다.
    - 네트 윗선(흰 테이프)은 바닥에서 1.55 m 위라 바닥 평면 계산에 못 쓴다. 기둥 바닥은 복식 사이드라인 위라 쓸 수 있다.
  - 설정 파일: `points`([{court, px}]), `lines`([{line:[[m],[m]], px:[[px]...]}]), `homography`(픽셀→코트),
    `h_court2px`, `point_errors`, `line_errors`, `mirrored`.
- **2 · 추적 · 서브 확인**
  - 영상 위: 슬롯별 박스(가려짐은 점선)·관절·속도, 심판 박스, 코트 라인
  - 위에서 본 코트: 슬롯별 위치와 최근 2초 궤적, 서비스 코트 구역
  - 타임라인: 슬롯별 보임/가려짐/없음 칸, 속도 곡선, 정지·랠리 기준선, 정지 구간(통과/탈락 색), 서브 표시와 점수.
    휠 확대, 드래그 이동, 클릭 이동. 위쪽 띠는 영상 전체 개요.
  - 정지 구간 목록: 모든 정지 구간이 어느 단계(A 정지 · B 대형 · C 랠리)에서 왜 탈락했는지, 통과했으면 서버 단서와 점수.
  - 기준값: `Params`의 서브 판정 값을 바꾸면 추적은 그대로 두고 서브 판정만 다시 계산(수 ms).
- **설정 파일**: 저장하면 `lab/config.json`(이 영상의 지금 설정). '코트·선수 설정 저장'은 `data/configs/<이름>.json`에도 저장하며
  이름 기본값은 영상 파일 이름이다(`match4.mp4` → `match4.json`). 영상 ID가 아니라 이름으로 찾으므로, 같은 이름의 영상을 다시 올리면
  (실험 설정이 아직 없을 때) "같은 이름의 설정 파일이 있어요. 사용하시겠습니까?"라고 묻고, 사용하면 코트·선수·심판·경기 설정을 그대로 불러온다.
  목록에서 다른 이름의 설정도 불러올 수 있다. 추적 결과가 지금 설정으로 만든 게 아니면(`tracks_meta.json` 비교) 확인 탭에서 알려 준다.
  찍는 중인 작업은 서버 설정과 다를 때만 브라우저(localStorage)에 임시 저장되고, 다시 열면 이어서 불러온다.
- `find_serves(..., debug={})`가 탈락 이유를 채운다. 서브 판정 기준값은 모두 `Params`에 있다
  (`rally_window`, `box_front`, `box_back`, `center_margin` 추가).
- `data/videos/`에 영상 파일을 직접 넣으면 목록을 열 때 자동 등록된다(ID = 파일 이름 해시, `source.*`는 원본을 가리키는 링크, 등록을 지워도 원본은 남음).
- 코트 자동 맞춤은 시도했으나 넣지 않음: 체육관에 코트가 여러 면이라 평행한 라인이 반복돼서, 몇 px만 어긋나도 옆 라인에 붙었다.

---

## 6. 검증 상태

| 항목 | 결과 |
|---|---|
| Detector ONNX (GPU) | 동작. 1080p 프레임당 약 17 ms |
| Pose ONNX | 동작. 일반 영상에서 관절 위치 육안 확인 |
| 전체 API 흐름 | 업로드 → 추천 → 검출 → 설정 → 분석 → 수정 → 합성 영상까지 오류 없음 (배드민턴이 아닌 1분 영상) |
| 분석 속도 | 1분 영상(969프레임) 약 26초 |
| 서브 검출 로직 | `tools/sim_serves.py` (가상 경기 5판 × 30서브). 서브 150/150 검출. 서버 판정: 4명 보임 99%, 팀원 가려짐 99%, 서버 팀원 놓침 95%, 양 팀원 놓침 91% (변경 전 코드는 팀원을 놓치면 서브 16/150만 검출) |
| 가려짐 추적 | 테스트 영상에서 겹쳐 선 두 사람 중 뒤쪽을 '가려짐'으로 유지하는 것 확인 |
| 실제 배드민턴 영상 | **아직 테스트 못 함** (서버에 경기 영상이 없음) |
| 화면 | 7단계 모두 라이트/다크에서 스크린샷으로 확인, JS 콘솔 오류 없음 |

---

## 7. 다음 작업

1. **실제 경기 영상으로 튜닝** (가장 중요)
   - `Params`: `still_speed`, `still_min`, `rally_speed`, 서비스 코트 여유값
   - 서버 자세 점수(`_pose_serve_score`)의 가중치. 먼 쪽(far) 선수는 작아서 관절 신뢰도가 낮을 수 있음
   - 정답 점수를 손으로 기록해서 서버 판정 정확도 측정
2. Detector가 배드민턴 영상에서 먼 쪽 선수를 놓치면 입력 크기를 키워 다시 변환(`--imgsz 768 1344` 등)하거나 파인튜닝(AI-Hub 데이터, 경기 단위 train/val 분리).
3. 게임 사이 휴식 시간에 선수가 코트를 떠났다 돌아오는 구간 처리 확인.
4. 단식 모드: 코드상 지원(슬롯 2개)하지만 서브 대형 규칙은 복식 기준이라 검증 필요.
5. 작업 정보 영구 저장(SQLite 등), 여러 사용자 동시 사용 시 큐 표시.

---

## 8. 주의 사항
- 카메라는 **고정**으로 가정 (코트 꼭짓점은 한 번만 지정).
- 브라우저가 못 읽는 코덱(HEVC 등)은 업로드 후 자동으로 720p H.264 사본(`preview.mp4`)을 만든다.
- 스코어보드 표시 시점: 점수는 **다음 서브 준비(4명 정지 시작) 시점**에 바뀐다. 영상의 마지막 랠리는 다음 서브가 없어서
  자동으로 셀 수 없음 → 결과 화면의 "마지막 랠리 승자 추가"로 입력.
- `~/yolov7`, `~/yolov26` 등 다른 프로젝트 환경은 건드리지 않았다. 이 프로젝트는 자체 `.venv`만 사용.
