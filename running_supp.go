package main

import (
	"fmt"
	"sync"
)

type runningSuppType struct {
	mu        sync.Mutex
	byUrlPath map[string]*Supp
	byMsgId   map[Msg]*Supp
}

var runningSupp = runningSuppType{
	byUrlPath: make(map[string]*Supp),
	byMsgId:   make(map[Msg]*Supp),
}

func (r *runningSuppType) Add(supp *Supp) {
	if supp.ChannelMsg.Id == 0 || supp.ArticleUrlPath == "" || supp.ChannelMsg.ChatId == 0 {
		panic(fmt.Sprintf("invalid supp: %+v", supp))
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.byUrlPath[supp.ArticleUrlPath] = supp
	r.byMsgId[supp.ChannelMsg] = supp
}

func (r *runningSuppType) Remove(supp *Supp) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.byUrlPath, supp.ArticleUrlPath)
	delete(r.byMsgId, supp.ChannelMsg)
}

func (r *runningSuppType) GetByMsg(msg Msg) (*Supp, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	res, ok := r.byMsgId[msg]
	return res, ok
}

func (r *runningSuppType) GetByUrlPath(urlPath string) (*Supp, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	res, ok := r.byUrlPath[urlPath]
	return res, ok
}

func (r *runningSuppType) Size() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.byUrlPath)
}
