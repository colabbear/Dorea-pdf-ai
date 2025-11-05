/* =====================================================
   Dorea Segment Manager Module - Segment Selection & Overlay
   ===================================================== */

import { showNotification } from './utils.js';

// 세그먼트 관리 변수
let segments = [];
let selectedSegments = [];
let maxSegments = 999; // 사실상 무제한
let selectedSegmentIds = []; // 선택된 세그먼트 ID 저장
let isImageModeActive = false; // 이미지 모드 상태


// 세그먼트 매니저 초기화
export function init() {
    // 🚀 개선된 페이지 렌더링 이벤트 리스너 (기존 방식과 병존)
    document.addEventListener('pageRendered', (event) => {
        const { viewport, pageNum, overlayId, viewMode } = event.detail;
        
        
        // 검증된 단일 렌더링 시스템 사용
        if ((viewMode === 'dual' || viewMode === 'continuous') && overlayId) {
            updateSegmentOverlayById(overlayId, viewport, pageNum);
        } else {
            updateSegmentOverlay(viewport, pageNum);
        }
    });
}

// 세그먼트 데이터 설정
export function setSegments(newSegments) {
    segments = newSegments || [];
}

// ID로 지정된 오버레이 업데이트 (듀얼 페이지 모드용)
function updateSegmentOverlayById(overlayId, viewport, pageNum) {
    const overlay = document.getElementById(overlayId);
    
    if (!overlay) {
        // 오버레이가 없으면 조용히 스킵
        return;
    }

    // 이전 세그먼트들 제거 (줌 변경시 위치 재계산을 위해)
    overlay.innerHTML = '';

    const pageSegments = segments.filter(s => {
        // 복합 bbox 처리
        if (s.is_compound && s.page_numbers) {
            return s.page_numbers.includes(pageNum);
        }
        // 기존 처리
        return s.page_number === pageNum
    });

    pageSegments.forEach((segment, index) => {
        const result = createSegmentElement(segment, index, pageNum, viewport);
        
        if (!Array.isArray(result)) {
        // 이전에 선택된 세그먼트인지 확인하고 선택 상태 복원
        const segmentEl = result;
        const segmentId = segment.id || `page${pageNum}_${index}`;
        if (selectedSegmentIds.includes(segmentId)) {
            if (selectedSegmentIds.length === 1) {
                segmentEl.classList.add('selected');
            } else {
                segmentEl.classList.add('multi-selected');
            }
            // selectedSegments 배열도 업데이트
            const existingIndex = selectedSegments.findIndex(s => s.id === segmentId || s.segmentId === segmentId);
            if (existingIndex === -1) {
                selectedSegments.push({ ...segment, element: segmentEl });
            } else {
                selectedSegments[existingIndex].element = segmentEl;
            }
        }
        
        overlay.appendChild(segmentEl);
        } else {
            // 복합 bbox: 배열의 모든 요소 추가
            const segmentId = result[0].dataset.segmentId;  
              
            result.forEach(segmentEl => {  
                // 선택 상태 복원  
                if (selectedSegmentIds.includes(segmentId)) {  
                    if (selectedSegmentIds.length === 1) {  
                        segmentEl.classList.add('selected');  
                    } else {  
                        segmentEl.classList.add('multi-selected');  
                    }  
                }  
                overlay.appendChild(segmentEl);  
            });  
              
            // selectedSegments 배열 업데이트 (첫 번째 요소만 저장)  
            if (selectedSegmentIds.includes(segmentId)) {  
                const existingIndex = selectedSegments.findIndex(s =>   
                    (s.id && s.id === segmentId) ||   
                    (s.element && s.element.dataset.segmentId === segmentId)  
                );  
                if (existingIndex === -1) {  
                    selectedSegments.push({ ...segment, element: result[0] });  
                } else {  
                    selectedSegments[existingIndex].element = result[0];  
                }  
            }
        }
    });
}

// 세그먼트 요소 생성 헬퍼 함수
function createSegmentElement(segment, index, pageNum, viewport) {

    // 복합 bbox가 아닌 경우: 기존 로직 사용
    if (!segment.is_compound || !segment.bounding_boxes) {
    const segmentEl = document.createElement('div');
    segmentEl.className = 'segment';
    segmentEl.dataset.segmentIndex = index;
    segmentEl.dataset.segmentId = segment.id || `page${pageNum}_${index}`;


    // 🚨 비정상 매트릭스 감지 및 수정
    const transform = viewport.transform;
    const isRotatedMatrix = (transform[0] === 0 && transform[3] === 0);
    
    let calculatedLeft, calculatedTop;
    
    // 🎯 근본 해결: PDF 좌표 → 화면 픽셀 변환 (Y축 반전 고려)
    
    // PDF.js transform matrix 사용 (PDF 포인트 → 화면 픽셀)
    const [scaleX, , , scaleY, offsetX, offsetY] = viewport.transform;
    calculatedLeft = segment.left * scaleX + offsetX;
    
    if (scaleY < 0) {
        // Y축이 뒤집힌 경우: Y좌표 반전 처리
        calculatedTop = (segment.top + segment.height) * scaleY + offsetY;
    } else {
        // 정상 Y축
        calculatedTop = segment.top * scaleY + offsetY;
    }

    // 🔄 Y좌표만 상하반전 (나머지 로직은 완벽하므로 건드리지 않음)
    const flippedTop = viewport.height - calculatedTop - (segment.height * Math.abs(scaleY));
    
    segmentEl.style.left = calculatedLeft + 'px';
    segmentEl.style.top = flippedTop + 'px';
    segmentEl.style.width = (segment.width * Math.abs(scaleX)) + 'px';
    segmentEl.style.height = (segment.height * Math.abs(scaleY)) + 'px';

    const typeColors = {
        'Text': 'rgba(59, 130, 246, 0.3)',
        'Picture': 'rgba(16, 185, 129, 0.3)',
        'Figure': 'rgba(16, 185, 129, 0.3)',
        'Table': 'rgba(245, 158, 11, 0.3)',
        'Title': 'rgba(190, 24, 93, 0.3)',
        'Caption': 'rgba(124, 58, 237, 0.3)'
    };

    segmentEl.style.backgroundColor = typeColors[segment.type] || 'rgba(59, 130, 246, 0.3)';

    segmentEl.addEventListener('click', (e) => {
        e.stopPropagation();
        handleSegmentClick(e, segment, segmentEl);
    });

    return segmentEl;
    } else {
    // 복합 bbox인 경우: 배열 반환  
    const elements = [];  
    const bboxes = segment.bounding_boxes;  
      
    // 현재 페이지의 bbox만 필터링  
    const pageBboxes = bboxes.filter(bbox => bbox.page_number === pageNum);  
      
    // 통일된 segment ID 생성  
    const unifiedSegmentId = `page${segment.chunk_index}`;
      
    pageBboxes.forEach((bbox, bboxIndex) => {  
        const segmentEl = document.createElement('div');  
        segmentEl.className = 'segment';  
        segmentEl.dataset.segmentId = unifiedSegmentId;  
        segmentEl.dataset.bboxIndex = bboxIndex;  
          
        // bbox 좌표로 변환 (기존 로직 재사용)  
        const [scaleX, , , scaleY, offsetX, offsetY] = viewport.transform;  
        const calculatedLeft = bbox.left * scaleX + offsetX;  
          
        let calculatedTop;  
        if (scaleY < 0) {  
            calculatedTop = (bbox.top + bbox.height) * scaleY + offsetY;  
        } else {  
            calculatedTop = bbox.top * scaleY + offsetY;  
        }  
          
        const flippedTop = viewport.height - calculatedTop - (bbox.height * Math.abs(scaleY));  
          
        segmentEl.style.left = calculatedLeft + 'px';  
        segmentEl.style.top = flippedTop + 'px';  
        segmentEl.style.width = (bbox.width * Math.abs(scaleX)) + 'px';  
        segmentEl.style.height = (bbox.height * Math.abs(scaleY)) + 'px';  
  
        const typeColors = {  
            'Text': 'rgba(59, 130, 246, 0.3)',  
            'Picture': 'rgba(16, 185, 129, 0.3)',  
            'Figure': 'rgba(16, 185, 129, 0.3)',  
            'Table': 'rgba(245, 158, 11, 0.3)',  
            'Title': 'rgba(190, 24, 93, 0.3)',  
            'Caption': 'rgba(124, 58, 237, 0.3)'  
        };  
  
        segmentEl.style.backgroundColor = typeColors[segment.type] || 'rgba(59, 130, 246, 0.3)';  
          
        segmentEl.addEventListener('click', (e) => {  
            e.stopPropagation();  
            handleSegmentClick(e, segment, segmentEl);  
        });  
          
        elements.push(segmentEl);  
    });  
      
    return elements; // 배열 반환  
    
    }


}

// 세그먼트 오버레이 업데이트 (단일 페이지 모드용)
function updateSegmentOverlay(viewport, pageNum) {
    const viewer = document.querySelector('.pdf-viewer');
    const overlay = viewer?.querySelector('.segment-overlay');
    
    if (!overlay) return;

    // 이전 세그먼트들 제거 (줌 변경시 위치 재계산을 위해)
    overlay.innerHTML = '';

    const pageSegments = segments.filter(s => {
        // 복합 bbox 처리
        if (s.is_compound && s.page_numbers) {
            return s.page_numbers.includes(pageNum);
        }
        // 기존 처리
        return s.page_number === pageNum
    });


    pageSegments.forEach((segment, index) => {
        const result = createSegmentElement(segment, index, pageNum, viewport);
        
        if (!Array.isArray(result)) {
        // 이전에 선택된 세그먼트인지 확인하고 선택 상태 복원
        const segmentEl = result
        const segmentId = segment.id || `page${pageNum}_${index}`;
        if (selectedSegmentIds.includes(segmentId)) {
            if (selectedSegmentIds.length === 1) {
                segmentEl.classList.add('selected');
            } else {
                segmentEl.classList.add('multi-selected');
            }
            // selectedSegments 배열도 업데이트
            const existingIndex = selectedSegments.findIndex(s => s.id === segmentId || s.segmentId === segmentId);
            if (existingIndex === -1) {
                selectedSegments.push({ ...segment, element: segmentEl });
            } else {
                selectedSegments[existingIndex].element = segmentEl;
            }
        }
        
        overlay.appendChild(segmentEl);
        } else {
            // 복합 bbox: 배열의 모든 요소 추가
    const segmentId = result[0].dataset.segmentId;  
      
    result.forEach(segmentEl => {  
        // 선택 상태 복원  
        if (selectedSegmentIds.includes(segmentId)) {  
            if (selectedSegmentIds.length === 1) {  
                segmentEl.classList.add('selected');  
            } else {  
                segmentEl.classList.add('multi-selected');  
            }  
        }  
        overlay.appendChild(segmentEl);  
    });  
      
    // selectedSegments 배열 업데이트 (첫 번째 요소만 저장)  
    if (selectedSegmentIds.includes(segmentId)) {  
        const existingIndex = selectedSegments.findIndex(s =>   
            (s.id && s.id === segmentId) ||   
            (s.element && s.element.dataset.segmentId === segmentId)  
        );  
        if (existingIndex === -1) {  
            selectedSegments.push({ ...segment, element: result[0] });  
        } else {  
            selectedSegments[existingIndex].element = result[0];  
        }  
    }
        }
    });
}

// 세그먼트 클릭 처리
function handleSegmentClick(event, segment, segmentEl) {
    const isCtrlPressed = event.ctrlKey || event.metaKey;
    const segmentId = segmentEl.dataset.segmentId;  
      
    // 복합 bbox인 경우 모든 관련 요소 찾기  
    const isCompound = segment.is_compound && segment.bounding_boxes;  
    const allRelatedElements = isCompound   
        ? document.querySelectorAll(`[data-segment-id="${segmentId}"]`)  
        : [segmentEl];  

    console.log(allRelatedElements);

    if (!isCtrlPressed) {
        // 단일 선택 로직
        const isAlreadySelected = segmentEl.classList.contains('selected');
        const wasOnlySelection = selectedSegments.length === 1 && isAlreadySelected;

        clearAllSegments();

        if (!wasOnlySelection) {
            allRelatedElements.forEach(el => {  
                el.classList.add('selected');  
            });  
            selectedSegments = [{ ...segment, element: segmentEl }];  
            console.log('복합 세그먼트 선택:', selectedSegments); // 디버깅용
            selectedSegmentIds = [segmentId];  
            updateSelectedSegmentUI(segment);  
        }
    } else {
        // 다중 선택 (기존 로직 유지하되 복합 bbox 동기화 추가)
        if (selectedSegments.length === 1 && selectedSegments[0].element.classList.contains('selected')) {  
            const firstId = selectedSegmentIds[0];  
            const firstElements = document.querySelectorAll(`[data-segment-id="${firstId}"]`);  
              
            firstElements.forEach(el => {  
                el.classList.remove('selected');  
                el.classList.add('multi-selected');  
            });  
        }  
  
        const existingIndex = selectedSegmentIds.indexOf(segmentId);  
  
        if (existingIndex !== -1) {  
            // 제거  
            selectedSegmentIds.splice(existingIndex, 1);  
            selectedSegments.splice(existingIndex, 1);  
            allRelatedElements.forEach(el => {  
                el.classList.remove('multi-selected');  
            });  
        } else {  
            // 추가  
            if (selectedSegments.length < maxSegments) {  
                selectedSegmentIds.push(segmentId);  
                selectedSegments.push({ ...segment, element: segmentEl });  
                allRelatedElements.forEach(el => {  
                    el.classList.add('multi-selected');  
                });  
            }  
        }  
  
        // UI 업데이트  
        if (selectedSegments.length > 1) {  
            updateMultiSegmentUI();  
        } else if (selectedSegments.length === 1) {  
            const lastId = selectedSegmentIds[0];  
            const lastElements = document.querySelectorAll(`[data-segment-id="${lastId}"]`);  
              
            lastElements.forEach(el => {  
                el.classList.remove('multi-selected');  
                el.classList.add('selected');  
            });  
            updateSelectedSegmentUI(selectedSegments[0]);  
        } else {  
            clearAllSegments();  
        }  
    }
}

// 모든 세그먼트 선택 해제
export function clearAllSegments() {
    selectedSegmentIds.forEach(segmentId => {  
        const allElements = document.querySelectorAll(`[data-segment-id="${segmentId}"]`);  
        allElements.forEach(el => {  
            el.classList.remove('selected', 'multi-selected');  
        });  
    });
    selectedSegments = [];
    selectedSegmentIds = [];
    
    const indicator = document.getElementById('selectedSegmentIndicator');
    const multiSegments = document.getElementById('multiSelectedSegments');
    const quickActions = document.getElementById('quickActions');
    
    if (indicator) indicator.style.display = 'none';
    if (multiSegments) multiSegments.style.display = 'none';
    if (quickActions) quickActions.style.display = 'none';
}

// 단일 세그먼트 선택 UI 업데이트
function updateSelectedSegmentUI(segment) {
    const indicator = document.getElementById('selectedSegmentIndicator');
    const preview = document.getElementById('segmentPreview');
    const quickActions = document.getElementById('quickActions');
    const segmentType = document.getElementById('segmentType');

    if (segmentType) segmentType.textContent = segment.type || 'Unknown';
    
    if (preview) {
        // 이미지 관련 세그먼트인 경우 축소 이미지 표시
        if ((segment.type === 'Picture' || segment.type === 'Figure') && segment.left !== undefined) {
            createSegmentPreviewImage(segment, preview);
        } else if (segment.text) {
            const previewText = segment.text.length > 100 
                ? segment.text.substring(0, 100) + '...' 
                : segment.text;
            preview.textContent = previewText;
        } else {
            preview.textContent = `페이지 ${segment.page_number} 영역`;
        }
    }

    if (indicator) indicator.style.display = 'block';
    if (quickActions) quickActions.style.display = 'flex';
    
    const multiSegments = document.getElementById('multiSelectedSegments');
    if (multiSegments) multiSegments.style.display = 'none';
}

// 세그먼트 영역의 축소 이미지 생성
function createSegmentPreviewImage(segment, previewElement) {
    try {
        // 해당 페이지의 캔버스 찾기
        const pageCanvas = document.querySelector(`canvas[data-page-number="${segment.page_number}"]`);
        if (!pageCanvas) {
            previewElement.textContent = `페이지 ${segment.page_number} 이미지 영역`;
            return;
        }

        // 캔버스 크기 정보
        const canvasWidth = pageCanvas.width;  // 내부 해상도
        const canvasHeight = pageCanvas.height; // 내부 해상도
        const canvasCSSWidth = pageCanvas.offsetWidth;  // CSS 표시 크기
        const canvasCSSHeight = pageCanvas.offsetHeight; // CSS 표시 크기
        
        // 현재 스케일 가져오기
        let currentScale = 1.0;
        if (window.pdfViewer && window.pdfViewer.getCurrentScale) {
            currentScale = window.pdfViewer.getCurrentScale();
        }
        
        // 실제 세그먼트 오버레이 위치 확인 (더 정확한 방법)
        let actualPosition = null;
        
        // 1. 먼저 선택된 세그먼트에서 실제 엘리먼트 찾기
        const selectedSegment = selectedSegments.find(s => s.id === segment.id || s.left === segment.left && s.top === segment.top);
        if (selectedSegment && selectedSegment.element) {
            const rect = selectedSegment.element.getBoundingClientRect();
            const canvasRect = pageCanvas.getBoundingClientRect();
            actualPosition = {
                left: rect.left - canvasRect.left,
                top: rect.top - canvasRect.top,
                width: rect.width,
                height: rect.height
            };
            console.log('📍 선택된 세그먼트 엘리먼트에서 위치 추출');
        } else {
            // 2. 폴백: data-segment-id로 찾기
            const segmentId = segment.id || `page${segment.page_number}_${segments.findIndex(s => s === segment)}`;
            const actualSegmentEl = document.querySelector(`[data-segment-id="${segmentId}"]`);
            if (actualSegmentEl) {
                const rect = actualSegmentEl.getBoundingClientRect();
                const canvasRect = pageCanvas.getBoundingClientRect();
                actualPosition = {
                    left: rect.left - canvasRect.left,
                    top: rect.top - canvasRect.top,
                    width: rect.width,
                    height: rect.height
                };
                console.log('🎯 data-segment-id로 위치 찾음');
            }
        }

        // 디버깅 로그
        console.log('🔍 세그먼트 미리보기 디버깅:', {
            segment: { left: segment.left, top: segment.top, width: segment.width, height: segment.height },
            canvas: { width: canvasWidth, height: canvasHeight },
            css: { width: canvasCSSWidth, height: canvasCSSHeight },
            currentScale,
            ratio: canvasWidth / canvasCSSWidth,
            viewport: window.currentPageViewports?.[segment.page_number] ? '있음' : '없음',
            actualSegmentPosition: actualPosition
        });
        
        // 🎯 새로운 접근: 실제 화면의 세그먼트 오버레이 위치를 직접 사용
        if (actualPosition) {
            // 실제 세그먼트 오버레이 위치를 캔버스 좌표로 변환
            const scaleRatio = canvasWidth / canvasCSSWidth;
            var x = actualPosition.left * scaleRatio;
            var y = actualPosition.top * scaleRatio; 
            var width = actualPosition.width * scaleRatio;
            var height = actualPosition.height * scaleRatio;
            
            console.log('✅ 실제 오버레이 위치 사용:', { x, y, width, height });
        } else {
            // 폴백: 원본 좌표 직접 사용
            const scaleRatio = canvasWidth / canvasCSSWidth;
            var x = segment.left * scaleRatio;
            var y = segment.top * scaleRatio; 
            var width = segment.width * scaleRatio;
            var height = segment.height * scaleRatio;
            
            console.log('⚠️ 폴백 좌표 사용:', { x, y, width, height });
        }

        // 좌표 유효성 검사
        if (x < 0 || y < 0 || width <= 0 || height <= 0 || 
            x + width > canvasWidth || y + height > canvasHeight) {
            previewElement.textContent = `페이지 ${segment.page_number} 이미지 영역`;
            return;
        }

        // 임시 캔버스 생성하여 해당 영역 복사
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');
        
        // 축소 이미지 크기 설정 (최대 100px)
        const maxSize = 100;
        const aspectRatio = width / height;
        let previewWidth, previewHeight;
        
        if (aspectRatio > 1) {
            previewWidth = Math.min(maxSize, width);
            previewHeight = previewWidth / aspectRatio;
        } else {
            previewHeight = Math.min(maxSize, height);
            previewWidth = previewHeight * aspectRatio;
        }
        
        tempCanvas.width = previewWidth;
        tempCanvas.height = previewHeight;
        
        // 원본 캔버스에서 해당 영역을 축소하여 복사
        tempCtx.drawImage(
            pageCanvas,
            x, y, width, height,  // 소스 영역
            0, 0, previewWidth, previewHeight  // 대상 영역
        );
        
        // 기존 내용 제거하고 이미지 추가
        previewElement.innerHTML = '';
        const img = document.createElement('img');
        img.src = tempCanvas.toDataURL();
        img.style.cssText = `
            max-width: 100px;
            max-height: 60px;
            border: 1px solid var(--border-primary);
            border-radius: 4px;
            object-fit: contain;
            background: white;
            display: block;
        `;
        previewElement.appendChild(img);
        
    } catch (error) {
        previewElement.textContent = `페이지 ${segment.page_number} 이미지 영역`;
    }
}

// 작은 미리보기 이미지 생성 헬퍼 함수
function createSmallPreviewImage(segment, size) {
    try {
        const pageCanvas = document.querySelector(`canvas[data-page-number="${segment.page_number}"]`);
        if (!pageCanvas) return null;

        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');
        
        tempCanvas.width = size;
        tempCanvas.height = size;
        
        // 세그먼트 영역에서 정사각형으로 크롭하여 복사
        const sourceSize = Math.min(segment.width, segment.height);
        const sourceX = segment.left + (segment.width - sourceSize) / 2;
        const sourceY = segment.top + (segment.height - sourceSize) / 2;
        
        tempCtx.drawImage(
            pageCanvas,
            sourceX, sourceY, sourceSize, sourceSize,
            0, 0, size, size
        );
        
        return tempCanvas.toDataURL();
    } catch (error) {
        return null;
    }
}

// 다중 세그먼트 선택 UI 업데이트
function updateMultiSegmentUI() {
    const container = document.getElementById('multiSelectedSegments');
    const list = document.getElementById('segmentsList');
    const count = document.getElementById('segmentsCount');

    if (selectedSegments.length === 0) {
        if (container) container.style.display = 'none';
        const quickActions = document.getElementById('quickActions');
        const indicator = document.getElementById('selectedSegmentIndicator');
        if (quickActions) quickActions.style.display = 'none';
        if (indicator) indicator.style.display = 'none';
        return;
    }

    if (count) count.textContent = `${selectedSegments.length}개`;
    
    if (list) {
        list.innerHTML = selectedSegments.map((segment, index) => {
            const typeMap = {
                'Text': { badge: 'badge-text', name: '텍스트' },
                'Picture': { badge: 'badge-picture', name: '이미지' },
                'Figure': { badge: 'badge-figure', name: '도표' },
                'Table': { badge: 'badge-table', name: '표' },
                'Title': { badge: 'badge-title', name: '제목' },
                'Caption': { badge: 'badge-caption', name: '캡션' }
            };

            const typeInfo = typeMap[segment.type] || { badge: 'badge-text', name: segment.type };
            
            // 이미지/도표 타입의 경우 미리보기 이미지 생성
            let previewImageHTML = '';
            if ((segment.type === 'Picture' || segment.type === 'Figure') && segment.left !== undefined) {
                const previewImageData = createSmallPreviewImage(segment, 40); // 40px 크기
                if (previewImageData) {
                    previewImageHTML = `
                        <img src="${previewImageData}" style="
                            width: 40px; 
                            height: 40px; 
                            border-radius: 4px; 
                            object-fit: cover; 
                            margin-right: 8px;
                            border: 1px solid var(--border-primary);
                        ">
                    `;
                }
            }
            
            return `
                <div class="segment-item" style="display: flex; align-items: center; padding: 8px;">
                    ${previewImageHTML}
                    <div style="flex: 1;">
                        <div class="segment-type-badge ${typeInfo.badge}" style="margin-bottom: 4px;">
                            ${typeInfo.name}
                        </div>
                        <div style="font-size: 12px; color: var(--text-secondary);">
                            페이지 ${segment.page_number}
                            ${segment.text ? ` • ${segment.text.substring(0, 30)}${segment.text.length > 30 ? '...' : ''}` : ''}
                        </div>
                    </div>
                    <button onclick="window.segmentManager.removeSegment(${index})" style="background: none; border: none; color: var(--text-tertiary); cursor: pointer; padding: 2px; margin-left: 8px;">×</button>
                </div>
            `;
        }).join('');
    }

    if (container) container.style.display = 'block';
    const quickActions = document.getElementById('quickActions');
    const indicator = document.getElementById('selectedSegmentIndicator');
    if (quickActions) quickActions.style.display = 'flex';
    if (indicator) indicator.style.display = 'none';
}

// 세그먼트 제거
export function removeSegment(index) {
    if (selectedSegments[index] && selectedSegments[index].element) {
        selectedSegments[index].element.classList.remove('multi-selected');
    }
    selectedSegments.splice(index, 1);
    updateMultiSegmentUI();
}

// 이미지 모드 토글
export function toggleImageMode() {
    isImageModeActive = !isImageModeActive;
    const toggleBtn = document.getElementById('imageToggleBtn');
    
    if (toggleBtn) {
        if (isImageModeActive) {
            toggleBtn.classList.add('active');
            toggleBtn.title = '정밀 모드 활성화됨: 모든 영역을 고화질 이미지로 정확하게 분석';
            showNotification('정밀 모드가 켜졌습니다. 이제 채팅 전송 시 선택된 영역이 고화질 이미지로 정확하게 분석됩니다.', 'info');
        } else {
            toggleBtn.classList.remove('active');
            toggleBtn.title = '정밀 모드: 모든 영역을 고화질 이미지로 정확하게 분석';
            showNotification('정밀 모드가 꺼졌습니다.', 'info');
        }
    }
}

// 이미지 모드 상태 확인
export function getImageModeStatus() {
    return isImageModeActive;
}

// 빠른 액션 처리
export function quickAction(action) {
    if (selectedSegments.length === 0) {
        showNotification('영역을 먼저 선택해주세요.', 'warning');
        return;
    }

    const actions = {
        'translate': '이 영역을 한국어로 번역해주세요.',
        'summarize': '이 영역을 요약해주세요.',
        'explain': '이 영역을 자세히 설명해주세요.',
        'analyze': '이 영역을 분석해주세요.'
    };

    const message = actions[action];
    if (message) {
        const chatInput = document.getElementById('chatInput');
        if (chatInput) {
            chatInput.value = message;
            // 메시지 전송 이벤트 발생
            const event = new CustomEvent('quickActionTriggered', {
                detail: { message, segments: selectedSegments }
            });
            document.dispatchEvent(event);
        }
    }
}

// 세그먼트를 이미지로 첨부하는 액션 처리 (📷 이미지로 버튼용)
async function handleImageAction() {
    try {
        showNotification('이미지 생성 중...', 'info');
        
        // 선택된 세그먼트들을 이미지로 변환
        const imagePromises = selectedSegments.map(async (segment) => {
            // pdfViewer의 captureSegmentAsImage 함수 사용
            if (window.pdfViewer && window.pdfViewer.captureSegmentAsImage) {
                return await window.pdfViewer.captureSegmentAsImage(segment);
            }
            return null;
        });

        const images = await Promise.all(imagePromises);
        const validImages = images.filter(img => img !== null);

        if (validImages.length === 0) {
            showNotification('이미지 생성에 실패했습니다.', 'error');
            return;
        }

        // 채팅 입력창에 이미지 첨부 메시지 설정
        const chatInput = document.getElementById('chatInput');
        if (chatInput) {
            const segmentCount = selectedSegments.length;
            const segmentTypes = [...new Set(selectedSegments.map(s => s.type))].join(', ');
            chatInput.value = `📷 이미지로 첨부됨 (${segmentCount}개 영역: ${segmentTypes})`;
        }

        // 이미지 첨부 이벤트 발생 (📷 이미지로 버튼 전용)
        const event = new CustomEvent('segmentImagesAttached', {
            detail: { 
                images: validImages, 
                segments: selectedSegments,
                message: `OCR 품질이 좋지 않아 이미지로 첨부합니다. 총 ${validImages.length}개 영역을 분석해주세요.`
            }
        });
        document.dispatchEvent(event);

        showNotification(`${validImages.length}개 영역이 이미지로 첨부되었습니다.`, 'success');
        
    } catch (error) {
        showNotification('이미지 생성 중 오류가 발생했습니다.', 'error');
    }
}

// Getters
export function getSelectedSegments() {
    return selectedSegments;
}

export function getSegments() {
    return segments;
}

// Export 함수들은 index.js에서 글로벌로 노출됨

// HTML onclick에서 사용할 수 있도록 전역 함수로 등록
window.clearAllSegments = clearAllSegments;
window.quickAction = quickAction;
window.toggleImageMode = toggleImageMode;