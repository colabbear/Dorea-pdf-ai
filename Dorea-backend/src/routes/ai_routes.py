"""
==========================================
AI/GPT Processing Routes Module
==========================================

AI 처리 관련 모든 라우트를 처리하는 모듈입니다.

기능:
- GPT 스트리밍 응답
- Vision API 처리 (이미지 분석)
- 멀티 세그먼트 분석
- AI 질문 응답

Author: Dorea Team  
Last Updated: 2024-08-22
"""

# FastAPI 관련 imports
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from typing import List, Dict, Any, Optional
import json
import httpx
import asyncio
import os

# 내부 모듈 imports  
from database import get_db, User, UserSettings, hash_api_key
from auth import get_current_user, create_openai_client

# Pydantic 모델 imports
from pydantic import BaseModel

# ==========================================
# Pydantic 모델 정의 
# ==========================================

class TextRequest(BaseModel):
    text: str

class QueryRequest(BaseModel):
    text: str
    query: str

class VisionRequest(BaseModel):
    image: str
    query: str

class MultiSegmentRequest(BaseModel):
    segments: List[Dict[str, Any]]
    query: str
    conversation_history: List[Dict[str, str]] = []

# ==========================================
# 환경 설정
# ==========================================

# OLLAMA API URL
OLLAMA_API_URL = os.getenv("OLLAMA_API_URL", "http://ollama:11434")

# ==========================================
# 유틸리티 함수
# ==========================================

# 1x1 픽셀 투명 PNG 이미지 (base64)
TINY_IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

# 멀티모달 지원 여부 캐시
multimodal_support_cache = {}

async def get_user_ai_provider_by_user(user: User, db: Session) -> tuple:
    """JWT 사용자의 AI 모델 설정 조회 - user_id 기반으로 조회"""
    # 🔥 사용자 ID를 기반으로 설정 조회 (API 키와 독립적)
    settings = db.query(UserSettings).filter(
        UserSettings.user_id == user.id
    ).first()
    
    if not settings:
        # 기본값 반환 (GPT)
        return "gpt", None, None, "gpt-4o"
    
    return settings.selected_model_provider, settings.selected_ollama_model, settings.openai_base_url, settings.openai_model

async def call_ollama_api(model_name: str, messages: list, stream: bool = False, images: list = None) -> dict:
    """Ollama API 호출 (멀티모달 지원)"""
    try:
        # Ollama API 메시지 형식으로 변환
        ollama_messages = []
        for msg in messages:
            if msg["role"] == "system":
                ollama_messages.append({"role": "system", "content": msg["content"]})
            elif msg["role"] == "user":
                user_message = {"role": "user", "content": msg["content"]}
                # 이미지가 있는 경우 추가
                if images:
                    user_message["images"] = images
                ollama_messages.append(user_message)
        
        payload = {
            "model": model_name,
            "messages": ollama_messages,
            "stream": stream,
            "options": {
                "keep_alive": "60s"  # 모델을 60초 동안 메모리에 유지 후 자동 해제
            }
        }
        
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                f"{OLLAMA_API_URL}/api/chat",
                json=payload,
                headers={"Content-Type": "application/json"}
            )
            
            if response.status_code == 200:
                if stream:
                    return response  # 스트리밍의 경우 응답 객체 자체를 반환
                else:
                    data = response.json()
                    return {"result": data.get("message", {}).get("content", "")}
            else:
                # API에서 받은 에러 메시지를 포함하여 예외 발생
                error_details = response.text
                raise Exception(f"Ollama API 오류: {response.status_code} - {error_details}")
                
    except Exception as e:
        raise Exception(f"Ollama 연결 오류: {str(e)}")

async def check_ollama_model_multimodal_support(model_name: str) -> bool:
    """실제 테스트 요청으로 Ollama 모델의 멀티모달 지원 여부 확인"""
    # 캐시에서 확인
    if model_name in multimodal_support_cache:
        return multimodal_support_cache[model_name]
    
    try:
        # 작은 더미 이미지로 테스트 요청
        payload = {
            "model": model_name,
            "messages": [
                {"role": "user", "content": "What is in this image?", "images": [TINY_IMAGE_BASE64]}
            ],
            "stream": False
        }
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(f"{OLLAMA_API_URL}/api/chat", json=payload)
            
            if response.status_code == 200:
                # 성공하면 멀티모달 지원
                multimodal_support_cache[model_name] = True
                return True
            else:
                # 에러 응답 내용 자세히 확인
                try:
                    error_data = response.json()
                    error_msg = error_data.get("error", "Unknown error")
                    print(f"🔍 멀티모달 테스트 ({model_name}): {response.status_code} - {error_msg}")
                    print(f"🔍 전체 오류 응답: {error_data}")
                    
                    # 다양한 에러 메시지 패턴 확인
                    error_lower = error_msg.lower()
                    if any(keyword in error_lower for keyword in ["image", "vision", "multimodal", "support"]):
                        multimodal_support_cache[model_name] = False
                        return False
                except Exception as parse_error:
                    print(f"🔍 멀티모달 테스트 ({model_name}): {response.status_code} - 응답 파싱 실패: {parse_error}")
                    print(f"🔍 원본 응답 텍스트: {response.text}")
        
        # 기타 에러는 미지원으로 처리
        multimodal_support_cache[model_name] = False
        return False
        
    except Exception as e:
        print(f"🔍 멀티모달 지원 테스트 예외 ({model_name}): {e}")
        multimodal_support_cache[model_name] = False
        return False

# ==========================================
# 라우터 설정
# ==========================================

router = APIRouter(prefix="/api", tags=["AI"])

# ==========================================
# AI 처리 라우트 
# ==========================================

# TODO: 현재 사용되지 않음 - 클라이언트에서 /multi-segment-stream만 사용 중
# @router.post("/stream")
# async def stream_gpt_response(
#     request: QueryRequest, 
#     current_user: User = Depends(get_current_user),
#     db: Session = Depends(get_db)
# ):
#     """AI 응답을 실제 스트리밍으로 반환 - GPT/Ollama 분기 지원"""
    
#     # 🔥 사용자 AI 설정을 미리 조회  
#     try:
#         provider, ollama_model, base_url = await get_user_ai_provider_by_user(current_user, db)
#     except:
#         provider, ollama_model, base_url = "gpt", None, None
    
#     # GPT 사용 시에만 API 키 확인
#     if provider == "gpt" and not current_user.api_key:
#         raise HTTPException(
#             status_code=400, 
#             detail="GPT 사용을 위해서는 OpenAI API 키가 필요합니다. 설정 페이지에서 API 키를 등록해주세요."
#         )
    
#     def generate_stream():  # 🔥 일반 def로 변경하되 내부에서 async 처리
#         try:
#             # 🔥 asyncio loop를 항상 미리 생성
#             import asyncio
#             loop = asyncio.new_event_loop()
#             asyncio.set_event_loop(loop)
            
#             if request.text:
#                 query = f"""다음 내용을 참고해서 질문에 답해줘:

# 텍스트:
# {request.text}

# 질문:
# {request.query}
# """
#             else:
#                 query = request.query
            
#             messages = [
#                 {
#                     "role": "system",
#                     "content": "당신은 PDF 문서 분석을 도와주는 AI 어시스턴트입니다. 한국어로 자세하고 정확하게 답변해주세요."
#                 },
#                 {
#                     "role": "user",
#                     "content": query
#                 }
#             ]
            
#             # 🔥 즉시 시작 신호
#             yield f"data: {json.dumps({'type': 'start', 'provider': provider})}\n\n"
            
#             if provider == "ollama" and ollama_model:
#                 # Ollama API 호출 - 동기 방식으로 처리
#                 try:
#                     ollama_response = loop.run_until_complete(call_ollama_api(ollama_model, messages, stream=True))
                    
#                     # Ollama 스트리밍 응답 처리 - 동기 방식
#                     for line_bytes in ollama_response.iter_lines():
#                         if line_bytes:
#                             try:
#                                 line = line_bytes.decode('utf-8') if isinstance(line_bytes, bytes) else line_bytes
#                                 data = json.loads(line)
#                                 if "message" in data and "content" in data["message"]:
#                                     content = data["message"]["content"]
#                                     if content:
#                                         yield f"data: {json.dumps({'type': 'chunk', 'content': content})}\n\n"
                                
#                                 if data.get("done", False):
#                                     break
#                             except json.JSONDecodeError:
#                                 continue
                                
#                 except Exception as e:
#                     yield f"data: {json.dumps({'type': 'error', 'error': f'Ollama 오류: {str(e)}'})}\n\n"
#                     yield f"data: {json.dumps({'type': 'done'})}\n\n"  # 에러 시에도 done 신호 전송
#                     return
#             else:
#                 # GPT API 호출 (기본값)
#                 client = create_openai_client(current_user.api_key, base_url)
                
#                 stream = client.chat.completions.create(
#                     model="gpt-4o",
#                     messages=messages,
#                     max_tokens=1000,
#                     temperature=0.7,
#                     stream=True
#                 )
                
#                 # 각 청크를 받는 즉시 yield
#                 for chunk in stream:
#                     if chunk.choices[0].delta.content is not None:
#                         content = chunk.choices[0].delta.content
#                         yield f"data: {json.dumps({'type': 'chunk', 'content': content})}\n\n"
            
#             # 완료 신호
#             yield f"data: {json.dumps({'type': 'done'})}\n\n"
            
#         except Exception as e:
#             yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"
    
#     return StreamingResponse(
#         generate_stream(),
#         media_type="text/event-stream",
#         headers={
#             "Cache-Control": "no-cache",
#             "Connection": "keep-alive",
#             "Access-Control-Allow-Origin": "*",
#             "X-Accel-Buffering": "no"
#         }
#     )

# TODO: 현재 사용되지 않음 - 클라이언트에서 /multi-segment-stream만 사용 중
# @router.post("/vision-stream")
# async def stream_vision_response(
#     request: VisionRequest,
#     current_user: User = Depends(get_current_user)
# ):
#     """Vision API 응답을 실제 스트리밍으로 반환"""
    
#     # API 키 확인
#     if not current_user.api_key:
#         raise HTTPException(
#             status_code=400, 
#             detail="API 키가 설정되지 않았습니다. 설정 페이지에서 API 키를 등록해주세요."
#         )
    
#     def generate_stream():  # 🔥 async def 대신 def 사용!
#         try:
#             client = create_openai_client(current_user.api_key)
            
#             base64_image = request.image
#             if "base64," in base64_image:
#                 base64_image = base64_image.split("base64,")[1]
            
#             messages = [
#                 {
#                     "role": "system",
#                     "content": "당신은 PDF 문서 분석을 도와주는 AI 어시스턴트입니다. 한국어로 자세하고 정확하게 답변해주세요."
#                 },
#                 {
#                     "role": "user",
#                     "content": [
#                         {"type": "text", "text": request.query},
#                         {
#                             "type": "image_url",
#                             "image_url": {"url": f"data:image/png;base64,{base64_image}"}
#                         }
#                     ]
#                 }
#             ]
            
#             yield f"data: {json.dumps({'type': 'start'})}\n\n"
            
#             stream = client.chat.completions.create(
#                 model="gpt-4o",
#                 messages=messages,
#                 max_tokens=1000,
#                 temperature=0.7,
#                 stream=True
#             )
            
#             for chunk in stream:
#                 if chunk.choices[0].delta.content is not None:
#                     content = chunk.choices[0].delta.content
#                     yield f"data: {json.dumps({'type': 'chunk', 'content': content})}\n\n"
            
#             yield f"data: {json.dumps({'type': 'done'})}\n\n"
            
#         except Exception as e:
#             yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"
    
#     return StreamingResponse(
#         generate_stream(),
#         media_type="text/event-stream",
#         headers={
#             "Cache-Control": "no-cache",
#             "Connection": "keep-alive",
#             "Access-Control-Allow-Origin": "*",
#             "X-Accel-Buffering": "no"
#         }
#     )

# === 멀티 세그먼트 처리 ===

# TODO: 현재 사용되지 않음 - 클라이언트에서 /multi-segment-stream만 사용 중
# @router.post("/multi-segment")
# async def analyze_multi_segments(
#     request: MultiSegmentRequest,
#     current_user: User = Depends(get_current_user)
# ):
#     """다중 세그먼트 분석"""
#     # API 키 확인
#     if not current_user.api_key:
#         raise HTTPException(
#             status_code=400, 
#             detail="API 키가 설정되지 않았습니다. 설정 페이지에서 API 키를 등록해주세요."
#         )
        
#     try:
#         client = create_openai_client(current_user.api_key)
        
#         # 세그먼트들을 분석해서 메시지 구성
#         content_parts = []
#         has_images = False
        
#         # 텍스트 세그먼트들 먼저 처리
#         text_context = f"사용자 질문: {request.query}\n\n"
#         text_context += f"다음 {len(request.segments)}개 영역을 종합하여 답변해주세요:\n\n"
        
#         for i, segment in enumerate(request.segments):
#             if segment['type'] == 'text':
#                 text_context += f"[영역 {i+1}] 페이지 {segment.get('page', '?')}:\n"
#                 text_context += f"{segment['content']}\n\n"
#             elif segment['type'] == 'image':
#                 has_images = True
#                 text_context += f"[영역 {i+1}] 페이지 {segment.get('page', '?')}: {segment.get('description', '이미지')}\n\n"
        
#         if has_images:
#             # 이미지가 있으면 Vision API 사용
#             content_parts.append({"type": "text", "text": text_context})
            
#             # 이미지들 추가
#             for segment in request.segments:
#                 if segment['type'] == 'image' and segment.get('content'):
#                     image_data = segment['content']
#                     if "base64," in image_data:
#                         image_data = image_data.split("base64,")[1]
                    
#                     content_parts.append({
#                         "type": "image_url",
#                         "image_url": {"url": f"data:image/png;base64,{image_data}"}
#                     })
            
#             messages = [
#                 {
#                     "role": "system",
#                     "content": "당신은 PDF 문서 분석을 도와주는 AI 어시스턴트입니다. 텍스트와 이미지를 종합하여 한국어로 자세하고 정확하게 답변해주세요."
#                 },
#                 {
#                     "role": "user",
#                     "content": content_parts
#                 }
#             ]
            
#             response = client.chat.completions.create(
#                 model="gpt-4o",
#                 messages=messages,
#                 max_tokens=1500,
#                 temperature=0.7
#             )
#         else:
#             # 텍스트만 있으면 일반 GPT 사용
#             messages = [
#                 {
#                     "role": "system",
#                     "content": "당신은 PDF 문서 분석을 도와주는 AI 어시스턴트입니다. 한국어로 자세하고 정확하게 답변해주세요."
#                 },
#                 {
#                     "role": "user",
#                     "content": text_context
#                 }
#             ]
            
#             response = client.chat.completions.create(
#                 model="gpt-4o",
#                 messages=messages,
#                 max_tokens=1500,
#                 temperature=0.7
#             )
        
#         return {"result": response.choices[0].message.content.strip()}
        
#     except Exception as e:
#         pass  # 로그 제거
#         raise HTTPException(status_code=500, detail=f"멀티 세그먼트 분석 오류: {str(e)}")

@router.post("/multi-segment-stream")
async def stream_multi_segment_response(
    request: MultiSegmentRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """다중 세그먼트 분석을 실제 스트리밍으로 반환 - GPT/Ollama 분기 지원"""
    
    # 🔥 사용자 AI 설정을 미리 조회  
    try:
        provider, ollama_model, base_url, openai_model = await get_user_ai_provider_by_user(current_user, db)
    except:
        provider, ollama_model, base_url, openai_model = "gpt", None, None, "gpt-4o"

    # GPT 사용 시에만 API 키 확인
    if provider == "gpt" and not current_user.api_key:
        raise HTTPException(
            status_code=400, 
            detail="GPT 사용을 위해서는 OpenAI API 키가 필요합니다. 설정 페이지에서 API 키를 등록해주세요."
        )
    
    
    def generate_stream():  # 🔥 일반 def로 변경하되 내부에서 async 처리
        try:
            # 🔥 asyncio loop를 항상 미리 생성
            import asyncio
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            
            # 컨텍스트 구성
            content_parts = []
            has_images = False
            image_data_list = []  # Ollama용 이미지 데이터 리스트
            
            text_context = f"## 현재 사용자 질문 (최우선):\n{request.query}\n\n"
            text_context += f"## 참고할 문서 영역 ({len(request.segments)}개):\n"
            
            for i, segment in enumerate(request.segments):
                if segment['type'] == 'text':
                    text_context += f"[영역 {i+1}] 페이지 {segment.get('page', '?')}:\n"
                    text_context += f"{segment['content']}\n\n"
                elif segment['type'] == 'image':
                    has_images = True
                    text_context += f"[영역 {i+1}] 페이지 {segment.get('page', '?')}: {segment.get('description', '이미지')}\n\n"
                    # Ollama용 이미지 데이터 추출 (base64) - GPT와 동일하게 'content' 필드 사용
                    if 'content' in segment and segment['content']:
                        image_data = segment['content']
                        # 데이터 URL 형식(e.g., "data:image/png;base64,iVBOR...")인 경우 순수 base64 데이터만 추출
                        if "base64," in image_data:
                            image_data = image_data.split("base64,")[1]
                        image_data_list.append(image_data)
            
            # 🔥 즉시 시작 신호 (어떤 제공자인지 알려줌)
            yield f"data: {json.dumps({'type': 'start', 'provider': provider})}\n\n"
            
            # 이미지가 있을 때 Ollama 모델의 멀티모달 지원 여부 확인
            if has_images and provider == "ollama":
                # 캐시에 없는 경우에만 테스트 중 메시지 표시
                if ollama_model not in multimodal_support_cache:
                    yield f"data: {json.dumps({'type': 'info', 'message': f'모델 {ollama_model}의 멀티모달 지원 여부를 확인하는 중...'})}\n\n"
                
                multimodal_support = loop.run_until_complete(check_ollama_model_multimodal_support(ollama_model))
                if not multimodal_support:
                    error_msg = f'선택된 모델 {ollama_model}은 이미지/표를 처리할 수 없습니다. GPT 모델을 사용하거나 멀티모달 모델을 다운로드해주세요.'
                    yield f"data: {json.dumps({'type': 'error', 'error': error_msg})}\n\n"
                    yield f"data: {json.dumps({'type': 'done'})}\n\n"  # 클라이언트 대기 방지를 위해 done 신호 전송
                    return
                else:
                    yield f"data: {json.dumps({'type': 'info', 'message': f'✅ 멀티모달 모델 {ollama_model}을 사용하여 이미지를 분석합니다.'})}\n\n"
            
            if provider == "ollama" and ollama_model:
                # Ollama API 호출 (텍스트 및 이미지 지원)
                try:
                    # 메시지 배열 구성 (시스템 메시지 + 대화 히스토리 + 현재 질문)
                    messages = [
                        {
                            "role": "system",
                            "content": "당신은 PDF 문서 분석을 도와주는 AI 어시스턴트입니다. 사용자의 현재 질문에 집중하여 정확하게 답변해주세요. 과거 대화는 참고만 하고, 현재 요청된 작업(요약, 번역, 분석 등)을 우선적으로 수행하세요."
                        }
                    ]
                    
                    # 대화 히스토리 추가
                    if request.conversation_history:
                        for msg in request.conversation_history:
                            messages.append({
                                "role": msg.get("role", "user"),
                                "content": msg.get("content", "")
                            })
                    
                    # 현재 질문 추가
                    messages.append({
                        "role": "user",
                        "content": text_context
                    })
                    
                    # 이미지가 있으면 전달, 없으면 None
                    images_to_send = image_data_list if has_images else None
                    print(f"🔍 이미지 전송 디버그: has_images={has_images}, 이미지 개수={len(image_data_list) if image_data_list else 0}")
                    if images_to_send and len(images_to_send) > 0:
                        print(f"🔍 첫 번째 이미지 데이터 길이: {len(images_to_send[0])}")
                    
                    ollama_response = loop.run_until_complete(call_ollama_api(ollama_model, messages, stream=True, images=images_to_send))
                    
                    # Ollama 스트리밍 응답 처리 - 동기 방식
                    for line_bytes in ollama_response.iter_lines():
                        if line_bytes:
                            try:
                                line = line_bytes.decode('utf-8') if isinstance(line_bytes, bytes) else line_bytes
                                data = json.loads(line)
                                if "message" in data and "content" in data["message"]:
                                    content = data["message"]["content"]
                                    if content:
                                        yield f"data: {json.dumps({'type': 'chunk', 'content': content})}\n\n"
                                
                                if data.get("done", False):
                                    break
                            except json.JSONDecodeError:
                                continue
                                
                except Exception as e:
                    yield f"data: {json.dumps({'type': 'error', 'error': f'Ollama 오류: {str(e)}'})}\n\n"
                    yield f"data: {json.dumps({'type': 'done'})}\n\n"  # 에러 시에도 done 신호 전송
                    return
            else:
                # OpenAI API 호출 (기본값 또는 이미지 포함)
                client = create_openai_client(current_user.api_key, base_url)
                
                if has_images:
                    content_parts.append({"type": "text", "text": text_context})
                    
                    for segment in request.segments:
                        if segment['type'] == 'image' and segment.get('content'):
                            image_data = segment['content']
                            if "base64," in image_data:
                                image_data = image_data.split("base64,")[1]
                            
                            content_parts.append({
                                "type": "image_url",
                                "image_url": {"url": f"data:image/png;base64,{image_data}"}
                            })
                    
                    # 메시지 배열 구성 (시스템 메시지 + 대화 히스토리 + 현재 질문)
                    messages = [
                        {
                            "role": "system",
                            "content": "당신은 PDF 문서 분석을 도와주는 AI 어시스턴트입니다. 텍스트와 이미지를 종합하여 한국어로 자세하고 정확하게 답변해주세요."
                        }
                    ]
                    
                    # 대화 히스토리 추가
                    if request.conversation_history:
                        for msg in request.conversation_history:
                            messages.append({
                                "role": msg.get("role", "user"),
                                "content": msg.get("content", "")
                            })
                    
                    # 현재 질문 추가
                    messages.append({
                        "role": "user",
                        "content": content_parts
                    })
                else:
                    # 메시지 배열 구성 (시스템 메시지 + 대화 히스토리 + 현재 질문)
                    messages = [
                        {
                            "role": "system",
                            "content": "당신은 PDF 문서 분석을 도와주는 AI 어시스턴트입니다. 사용자의 현재 질문에 집중하여 한국어로 정확하게 답변해주세요. 과거 대화는 참고만 하고, 현재 요청된 작업(요약, 번역, 분석 등)을 우선적으로 수행하세요."
                        }
                    ]
                    
                    # 대화 히스토리 추가
                    if request.conversation_history:
                        for msg in request.conversation_history:
                            messages.append({
                                "role": msg.get("role", "user"),
                                "content": msg.get("content", "")
                            })
                    
                    # 현재 질문 추가
                    messages.append({
                        "role": "user",
                        "content": text_context
                    })
                
                
                stream = client.chat.completions.create(
                    model=openai_model,
                    messages=messages,
                    max_tokens=1500,
                    temperature=0.7,
                    stream=True
                )
                
                for chunk in stream:
                    if chunk.choices[0].delta.content is not None:
                        content = chunk.choices[0].delta.content
                        yield f"data: {json.dumps({'type': 'chunk', 'content': content})}\n\n"
            
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
            
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"
    
    return StreamingResponse(
        generate_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
            "X-Accel-Buffering": "no"
        }
    )
# 기존 send_openai_query 함수를 이것으로 교체
async def send_openai_query(query: str, api_key: str, base64_image: Optional[str] = None, base_url: Optional[str] = None):
    """OpenAI API 호출 헬퍼 함수"""
    try:
        client = create_openai_client(current_user.api_key, base_url)
        
        messages = [
            {
                "role": "system",
                "content": "당신은 PDF 문서 분석을 도와주는 AI 어시스턴트입니다. 한국어로 자세하고 정확하게 답변해주세요."
            }
        ]
        
        if base64_image:
            # 🆕 base64 이미지 정리 - dataURL 헤더 제거
            if base64_image.startswith('data:image'):
                base64_image = base64_image.split(',')[1]
            
            messages.append({
                "role": "user",
                "content": [
                    {"type": "text", "text": query},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{base64_image}"}
                    }
                ]
            })
            model = "gpt-4o"
        else:
            messages.append({
                "role": "user", 
                "content": query
            })
            model = "gpt-4o"
        
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=1000,
            temperature=0.7
        )
        
        return {"result": response.choices[0].message.content.strip()}
        
    except Exception as e:
        pass  # 로그 제거
        raise HTTPException(status_code=500, detail=f"OpenAI API 오류: {str(e)}")

# AI 질문 응답 (GPT/Ollama 분기 지원)
# TODO: 현재 사용되지 않음 - 클라이언트에서 /multi-segment-stream만 사용 중
# @router.post("/ask")
# async def ask_gpt(
#     request: QueryRequest, 
#     current_user: User = Depends(get_current_user),
#     db: Session = Depends(get_db)
# ):
#     """AI에게 질문하기 - GPT/Ollama 분기 지원"""
    
#     # API 키 확인
#     if not current_user.api_key:
#         raise HTTPException(
#             status_code=400, 
#             detail="API 키가 설정되지 않았습니다. 설정 페이지에서 API 키를 등록해주세요."
#         )
    
#     try:
#         # 사용자 AI 설정 조회
#         provider, ollama_model, base_url = await get_user_ai_provider_by_user(current_user, db)
        
#         if request.text:
#             query = f"""다음 내용을 참고해서 질문에 답해줘:

# 텍스트:
# {request.text}

# 질문:
# {request.query}
# """
#         else:
#             query = request.query
        
#         messages = [
#             {
#                 "role": "system",
#                 "content": "당신은 PDF 문서 분석을 도와주는 AI 어시스턴트입니다. 한국어로 자세하고 정확하게 답변해주세요."
#             },
#             {
#                 "role": "user",
#                 "content": query
#             }
#         ]
        
#         if provider == "ollama" and ollama_model:
#             # Ollama API 호출
#             result = await call_ollama_api(ollama_model, messages, stream=False)
#             return result
#         else:
#             # GPT API 호출 (기본값)
#             return await send_openai_query(query, api_key, base_url)
            
#     except Exception as e:
#         pass  # 로그 제거
#         raise HTTPException(status_code=500, detail=f"AI 질문 처리 오류: {str(e)}")


# TODO: 현재 사용되지 않음 - 클라이언트에서 /multi-segment-stream만 사용 중
# @router.post("/vision")
# async def vision_analysis(request: VisionRequest, current_user: User = Depends(get_current_user)):
#     """이미지를 GPT Vision으로 분석"""
    
#     # API 키 확인
#     if not current_user.api_key:
#         raise HTTPException(
#             status_code=400, 
#             detail="API 키가 설정되지 않았습니다. 설정 페이지에서 API 키를 등록해주세요."
#         )
    
#     try:
#         print(f"🔍 Vision 요청 받음")
#         print(f"📝 Query: {request.query}")
#         print(f"🖼️ 이미지 데이터 길이: {len(request.image) if request.image else 0}")
        
#         # 🆕 이미지 크기 체크
#         if len(request.image) > 100000:  # 100KB 제한
#             print(f"⚠️ 이미지가 너무 큼: {len(request.image)} bytes")
#             raise HTTPException(status_code=400, detail="이미지 크기가 너무 큽니다. 더 작은 영역을 선택해주세요.")
        
#         # dataURL 형식에서 base64 추출
#         base64_image = request.image
#         if "base64," in base64_image:
#             base64_image = base64_image.split("base64,")[1]
#             print(f"✅ Base64 추출 완료, 길이: {len(base64_image)}")
        
#         result = await send_openai_query(request.query, api_key, base64_image)
#         print(f"✅ OpenAI 응답 받음")
        
#         return result
        
#     except Exception as e:
#         print(f"❌ Vision API 에러: {str(e)}")
#         raise HTTPException(status_code=500, detail=f"Vision API 오류: {str(e)}")
    


# TODO: backend.py에서 다음 함수들을 복사해서 여기에 붙여넣기:
# 1. @router.post("/stream") - stream_gpt_response
# 2. @router.post("/vision-stream") - stream_vision_response
# 3. @router.post("/multi-segment") - analyze_multi_segments  
# 4. @router.post("/multi-segment-stream") - stream_multi_segment_response
# 5. @router.post("/ask") - ask_gpt
# 6. @router.post("/vision") - vision_analysis

# 이 라우트들을 복사할 때:
# - @router.post → @router.post로 변경
# - "/"로 시작하는 경로에서 "/" 제거 (예: "/stream" → "/stream")